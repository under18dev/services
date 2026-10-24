import { buildClearedSessionCookie, sessionCookieName } from "@u18/contracts";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { ACCOUNT_BASE_PATH } from "./base-path";
import { RpcIdentityGateway, asIdentityRpc } from "./infrastructure/rpc/identity.gateway";
import type { IdentityGateway } from "./application/ports";
import type { IdentityFailure } from "./domain/errors";

type Bindings = Env;
type Variables = { identity: IdentityGateway };

const root = new Hono<{ Bindings: Bindings; Variables: Variables }>();

root.use("*", secureHeaders());

root.use("*", async (c, next) => {
  c.set("identity", new RpcIdentityGateway(asIdentityRpc(c.env.IDENTITY)));
  await next();
});

/**
 * 以降のルートはすべてこの `app` に登録する（接頭辞の理由は
 * `base-path.ts` を参照）。
 *
 * `basePath()` が返すのは router を共有した別インスタンスなので、
 * `root` に付けたミドルウェアはそのまま効く。**新しいエンドポイントを
 * 足すときは必ず `app` のほうを使うこと。** `root` に直接足すと、
 * 本番で到達不能なエンドポイントが 1 つ増える。
 */
const app = root.basePath(ACCOUNT_BASE_PATH);

function statusFor(failure: IdentityFailure): 401 | 403 | 404 | 503 {
  switch (failure.kind) {
    case "unauthenticated":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "identity_unavailable":
      return 503;
  }
}

/**
 * 死活確認（#44）。
 *
 * ## Identity まで確かめる
 *
 * 以前はこの Worker 自身の状態しか返しておらず、**auth-worker が完全に
 * 停止していても 200 を返していた。** dashboard は認証機能のすべてを
 * RPC に依存しているので、それは「何も機能していない状態で緑に見える」
 * ということに等しい。外形監視をここへ向ける以上、依存先まで含めて
 * 1 つの指標にする（auth-worker の `/health` が D1 まで見ているのと同じ）。
 *
 * RPC が失敗・タイムアウトしたときは **200 を返さない。** 200 を返すなら
 * この確認を足した意味が無い。
 *
 * ## パス
 *
 * 他のエンドポイントと同じく `/account/health` に載る。本番の route が
 * `auth.under18.dev/account/*` である以上、接頭辞の外に置いたら
 * 到達不能で、監視は常に 404 を見ることになる（#106）。
 */
app.get("/health", async (c) => {
  const startedAt = Date.now();
  const identity = await c.get("identity").pingIdentity();

  // 「Identity が degraded を返した」と「そもそも届かなかった」を
  // 区別して出す。前者は auth-worker の D1、後者は Binding か Worker 自体。
  // 切り分けの手掛かりを 1 つの文字列に潰さない。
  const check = !identity.ok
    ? ("unreachable" as const)
    : identity.value.status === "ok"
      ? ("ok" as const)
      : ("degraded" as const);
  const healthy = check === "ok";

  return c.json(
    {
      status: healthy ? ("ok" as const) : ("degraded" as const),
      service: "u18-dashboard",
      environment: c.env.ENVIRONMENT,
      checks: { identity: check },
      latencyMs: Date.now() - startedAt,
    },
    healthy ? 200 : 503,
  );
});

/**
 * BFF: 自分のプロフィールを返す。
 *
 * dashboard-worker は Identity DB に触らず、必ず RPC 越しに問い合わせる
 * （仕様書 2.2 / 4.1）。
 */
app.get("/api/me", async (c) => {
  const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
  if (token === undefined) return c.json({ error: "unauthenticated" }, 401);

  const result = await c.get("identity").getProfile(token);
  if (!result.ok) return c.json({ error: result.failure.kind }, statusFor(result.failure));
  if (result.value === null) return c.json({ error: "unauthenticated" }, 401);

  return c.json(result.value);
});

app.get("/api/me/sessions", async (c) => {
  const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
  if (token === undefined) return c.json({ error: "unauthenticated" }, 401);

  const result = await c.get("identity").listSessions(token);
  if (!result.ok) return c.json({ error: result.failure.kind }, statusFor(result.failure));

  return c.json({ sessions: result.value });
});

/**
 * 状態を変える操作の Origin 検証（仕様書 9 CSRF）。
 *
 * Origin 欠如も拒否する（fail-closed）。「無ければ通す」にすると、
 * ヘッダを落とせる経路があった時点で CSRF 対策が SameSite 頼みになる。
 */
function hasTrustedOrigin(c: Context<{ Bindings: Bindings; Variables: Variables }>): boolean {
  return c.req.header("Origin") === new URL(c.req.url).origin;
}

app.delete("/api/me/sessions/:id", async (c) => {
  const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
  if (token === undefined) return c.json({ error: "unauthenticated" }, 401);

  if (!hasTrustedOrigin(c)) return c.json({ error: "forbidden" }, 403);

  const result = await c.get("identity").revokeSession(token, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.failure.kind }, statusFor(result.failure));

  // 自分自身のセッションを消した場合**だけ** Cookie を落とす（auth-worker と同じ判断）。
  // 落とさないと、失効済みの Cookie をブラウザが送り続け、次に 401 を
  // 踏むまで「ログアウトが効かなかった」ように見える。
  // revoked だけで判断すると、別端末を失効させた操作で自分がログアウトされる。
  if (result.value.revoked && result.value.self) {
    c.header("Set-Cookie", buildClearedSessionCookie(c.env.ENVIRONMENT), { append: true });
  }

  return c.json(result.value);
});

/**
 * BFF: 同意済みアプリの一覧（#18）。
 *
 * `/api/me/sessions` と同じく、auth-worker から受けた DTO を**加工せず**
 * そのまま返す。つまり `GrantListItem` に項目を足すと、それはそのまま
 * 利用者のブラウザへ届く（packages/contracts/src/identity.ts）。
 */
app.get("/api/me/grants", async (c) => {
  const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
  if (token === undefined) return c.json({ error: "unauthenticated" }, 401);

  const result = await c.get("identity").listGrants(token);
  if (!result.ok) return c.json({ error: result.failure.kind }, statusFor(result.failure));

  return c.json({ grants: result.value });
});

/**
 * BFF: 同意を取り消す（#18）。
 *
 * パスパラメータは**公開 `client_id`**。auth-worker 側が内部 ID を
 * DTO に載せていないので、この Worker は内部 ID を知りようがない。
 *
 * 取り消しはセッションを切らないので、`DELETE /api/me/sessions/:id` と違って
 * Cookie には触れない。操作者は引き続きログインしたままで、消えるのは
 * 「そのアプリからの自分の情報へのアクセス」だけである。
 */
app.delete("/api/me/grants/:clientId", async (c) => {
  const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
  if (token === undefined) return c.json({ error: "unauthenticated" }, 401);

  if (!hasTrustedOrigin(c)) return c.json({ error: "forbidden" }, 403);

  const result = await c.get("identity").revokeGrant(token, c.req.param("clientId"));
  if (!result.ok) return c.json({ error: result.failure.kind }, statusFor(result.failure));

  return c.json(result.value);
});

// 公開するのは `root`。`app` は `root` の router を共有しているので、
// 上で登録したハンドラはすべてここから引ける。
export default root satisfies ExportedHandler<Bindings>;
