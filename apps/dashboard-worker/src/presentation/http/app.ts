import { buildClearedSessionCookie, sessionCookieName } from "@u18/contracts";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { createContainer } from "../../composition/container";
import type { IdentityFailure } from "../../domain/errors";
import { ACCOUNT_BASE_PATH } from "./base-path";
import type { AppBindings } from "./types";

export { ACCOUNT_BASE_PATH } from "./base-path";

/**
 * dashboard-worker の HTTP アプリ。
 *
 * ## ルートを `src/index.ts` ではなくここに置く理由
 *
 * `packages/config/eslint.layers.js` のレイヤ規則は各 Worker の
 * `src/presentation/` 配下だけを対象にしている。**`src/index.ts` に書いた
 * ハンドラはレイヤ lint の対象外**になる（`docs/architecture.md` 9-2、#119）。
 *
 * この Worker のハンドラは認可の入口そのもの（Cookie を読み、Origin を
 * 確かめ、RPC の失敗を HTTP ステータスへ翻訳する）なので、「Presentation が
 * Infrastructure を直接触っていない」ことを人のレビューではなく lint で
 * 保証したい。auth-worker と nfc-worker が同じ形になっている。
 *
 * ## `src/index.ts` に置けないものがある
 *
 * Worker のエントリモジュールは**既定ハンドラと Entrypoint クラス以外の
 * 名前付き export を持てない**。`ACCOUNT_BASE_PATH` をここから再 export
 * しているのはそのため（詳細は `base-path.ts`）。
 */
export function createApp(): Hono<AppBindings> {
  const root = new Hono<AppBindings>();

  root.use("*", secureHeaders());

  // **キャッシュさせないのを既定にする（#125 / RR-10）。**
  //
  // この Worker が返すのは全部 auth-worker から中継した個人情報
  // （プロフィール・セッション一覧・同意済みアプリ）である。
  // 中間プロキシやブラウザに残ると、共用端末で前の利用者の情報が戻る。
  //
  // auth-worker と違い、**意図的に違う値を使う経路は 1 つも無い。**
  // 静的アセットも公開メタデータもこの Worker には無いので、
  // ここで付けた値がそのまま全経路に出る。
  root.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  // 組み立てをミドルウェアに閉じ込め、各ルートは `c.get("identity")` だけを
  // 見る。ルートから `Env` を直接触らせない。
  root.use("*", async (c, next) => {
    c.set("identity", createContainer(c.env).identity);
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
  function hasTrustedOrigin(c: Context<AppBindings>): boolean {
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

  // 返すのは `root`。`app` は `root` の router を共有しているので、
  // 上で登録したハンドラはすべてここから引ける。
  return root;
}
