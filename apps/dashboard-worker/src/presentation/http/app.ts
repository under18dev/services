import { buildClearedSessionCookie, sessionCookieName } from "@u18/contracts";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import type { BlankSchema } from "hono/types";
import { createContainer } from "../../composition/container";
import type { IdentityFailure } from "../../domain/errors";
import { ACCOUNT_BASE_PATH } from "./base-path";
import { accountUiRoutes } from "./ui/account.routes";
import type { AppBindings } from "./types";

export { ACCOUNT_BASE_PATH } from "./base-path";

function statusFor(failure: IdentityFailure): 401 | 403 | 404 | 409 | 503 {
  switch (failure.kind) {
    case "unauthenticated":
      return 401;
    case "forbidden":
      return 403;
    // auth-worker の HTTP 経路と同じ 403。**本文の `error` で区別する** ——
    // 「権限が無い」と「もう一度ログインすれば通る」は利用者の次の行動が
    // 違うので、ステータスだけでは足りない。
    case "reauthentication_required":
      return 403;
    case "not_found":
      return 404;
    /**
     * 409。username の重複と、管理者の最後の Passkey。
     *
     * 400 にしない —— 入力の形は正しく、**いまの状態では通らない**
     * という意味である。利用者が直せるもの（別の username）と
     * 直せないもの（管理者は 1 本残す）の両方が入る。
     */
    case "conflict":
      return 409;
    case "identity_unavailable":
      return 503;
  }
}

/**
 * 状態を変える操作の Origin 検証（仕様書 9 CSRF）。
 *
 * Origin 欠如も拒否する（fail-closed）。「無ければ通す」にすると、
 * ヘッダを落とせる経路があった時点で CSRF 対策が SameSite 頼みになる。
 */
function hasTrustedOrigin(c: Context<AppBindings>): boolean {
  return c.req.header("Origin") === new URL(c.req.url).origin;
}

/**
 * ルートを登録する相手。`root.basePath(ACCOUNT_BASE_PATH)` の型である。
 *
 * 型を明示しているのは `registerRoutes` を `createApp` の外に出すため。
 * 外に出す理由は `registerRoutes` の JSDoc を参照。
 */
type AccountRouter = Hono<AppBindings, BlankSchema, typeof ACCOUNT_BASE_PATH>;

/**
 * すべてのエンドポイントを **1 本のチェーンで** 登録する。
 *
 * ## チェーンを切らないこと
 *
 * `hono/client` の `hc<DashboardAppType>` は、チェーンの戻り値に積まれた
 * 型からパスと本文の型を作る。文を分けて `app.get(...); app.get(...);` と
 * 書くと **`typeof` には何も積まれず、クライアントは空の型になる。**
 *
 * **空でも補完が出ないだけで型検査は通る。** 「宣言はあるが発動しない」の
 * 型版で、このリポジトリで何度も踏んでいる形である（#88 / #96 / #122 / #164）。
 *
 * 効いていることは `test/client-type.test-d.ts` が固定している。存在しない
 * パスに `@ts-expect-error` を付けてあるので、型が空（= 何でも許す）に
 * 戻ると**エラーが出なくなって `@ts-expect-error` 自身が落ちる。**
 * つまり `pnpm typecheck` が通ること自体が「チェーンが切れていない」証拠。
 *
 * ## なぜ `createApp` の外にあるのか
 *
 * `DashboardAppType` を `ReturnType<typeof registerRoutes>` として外へ
 * 出すため。`createApp` の中の局所関数だと `typeof` で掴めない。
 */
function registerRoutes(app: AccountRouter) {
  return (
    app
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
      .get("/health", async (c) => {
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
            // environment は返さない（RR-18）。未認証で読める構成情報を増やさない。
            // この値を読んでいる検査は無かった —— dashboard のスモークテストは
            // /account/api/me の 401 を見ている。
            checks: { identity: check },
            latencyMs: Date.now() - startedAt,
          },
          healthy ? 200 : 503,
        );
      })

      /**
       * BFF: 自分のプロフィールを返す。
       *
       * dashboard-worker は Identity DB に触らず、必ず RPC 越しに問い合わせる
       * （仕様書 2.2 / 4.1）。
       */
      .get("/api/me", async (c) => {
        const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
        if (token === undefined) return c.json({ error: "unauthenticated" } as const, 401);

        const result = await c.get("identity").getProfile(token);
        if (!result.ok) return c.json({ error: result.failure.kind }, statusFor(result.failure));
        if (result.value === null) return c.json({ error: "unauthenticated" } as const, 401);

        return c.json(result.value);
      })

      .delete("/api/me/sessions/:id", async (c) => {
        const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
        if (token === undefined) return c.json({ error: "unauthenticated" } as const, 401);

        if (!hasTrustedOrigin(c)) return c.json({ error: "forbidden" } as const, 403);

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
      })

      /**
       * BFF: プロフィールの更新（仕様書 8.1 / #11）。
       *
       * 変えられるのは `displayName` と `username` だけ。**`username` の変更には
       * 再認証が要る** —— 判定は auth-worker の UseCase の中にあり、この
       * Worker は結果を翻訳するだけ。ここに判定を写すと 2 箇所になり、
       * **片方だけ緩める変更が通ってしまう。**
       */
      .patch("/api/me", async (c) => {
        const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
        if (token === undefined) return c.json({ error: "unauthenticated" } as const, 401);

        if (!hasTrustedOrigin(c)) return c.json({ error: "forbidden" } as const, 403);

        // 本文の形だけ見る。長さや文字種の検証は auth-worker が正本
        // （2 箇所で検証すると、片方だけ緩めた変更が通る）。
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ error: "invalid_input" } as const, 400);
        }
        if (typeof body !== "object" || body === null) {
          return c.json({ error: "invalid_input" } as const, 400);
        }

        const { displayName, username } = body as Record<string, unknown>;
        const changes: { displayName?: string; username?: string } = {};
        if (typeof displayName === "string") changes.displayName = displayName;
        if (typeof username === "string") changes.username = username;
        if (Object.keys(changes).length === 0) {
          return c.json({ error: "invalid_input" } as const, 400);
        }

        const result = await c.get("identity").updateProfile(token, changes);
        if (!result.ok) return c.json({ error: result.failure.kind }, statusFor(result.failure));

        return c.json(result.value);
      })

      /**
       * BFF: Passkey の削除（仕様書 8.1 / #75）。
       *
       * **再認証が要る。** セッションの盗用がそのまま認証器の剥奪に
       * ならないようにするため。判定は auth-worker 側にあり、ここは
       * `reauthentication_required` を 403 として返すだけ。
       *
       * **管理者は最後の 1 本を削除できない**（決定 8）。これも auth-worker
       * 側の判定で、ここには `conflict` として届く（409）。
       */
      .delete("/api/me/passkeys/:id", async (c) => {
        const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
        if (token === undefined) return c.json({ error: "unauthenticated" } as const, 401);

        if (!hasTrustedOrigin(c)) return c.json({ error: "forbidden" } as const, 403);

        const result = await c.get("identity").deletePasskey(token, c.req.param("id"));
        if (!result.ok) return c.json({ error: result.failure.kind }, statusFor(result.failure));

        return c.json(result.value);
      })

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
      .delete("/api/me/grants/:clientId", async (c) => {
        const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
        if (token === undefined) return c.json({ error: "unauthenticated" } as const, 401);

        if (!hasTrustedOrigin(c)) return c.json({ error: "forbidden" } as const, 403);

        const result = await c.get("identity").revokeGrant(token, c.req.param("clientId"));
        if (!result.ok) return c.json({ error: result.failure.kind }, statusFor(result.failure));

        return c.json(result.value);
      })
  );
}

/**
 * `hono/client` に渡す型。`hc<DashboardAppType>(...)` と使う。
 *
 * **値ではなく型だけを export すること。** この Worker の `src/index.ts` は
 * エントリモジュールなので名前付き export を持てないが、`app.ts` 自体は
 * 普通のモジュールなので型は出せる。
 */
export type DashboardAppType = ReturnType<typeof registerRoutes>;

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
  // `strict: false` で末尾スラッシュの有無を同一視する。
  //
  // **これが無いと `/account` と `/account/` の片方が 404 になる。**
  // どちらが生きるかは登録の書き方で決まり、`basePath("/account")` の下に
  // `get("/")` と書けば `/account/` だけ、`route("/", ...)` で合流させれば
  // `/account` だけが届く。**利用者が URL バーに打つのは前者**なので、
  // どちらの書き方でも踏めるようにしておく。nfc-worker（`app.ts` の
  // 同じ指定）と揃える。
  const root = new Hono<AppBindings>({ strict: false });

  // **`Referrer-Policy` を既定（`no-referrer`）のままにしない（#226 / #228）。**
  //
  // Fetch 仕様では、referrer policy が参照元を落とすとき**ナビゲーション
  // 要求の `Origin` も `null` になる**。自分のページから出した form 送信が
  // `Origin: null` で届き、Origin 検証に落ちる。auth-worker が本番で
  // これを踏み、ログイン・新規登録・ログアウトが全滅した（#226）。
  //
  // **この Worker にはまだ form POST が無いので、いまは壊れていない。**
  // それでも揃えるのは、無事である理由が「form がまだ無い」ことだけだから
  // である。#208（JS 無しで他端末のセッションを切る）を入れた時点で、
  // 同じ障害を同じ形で踏む。そのとき `@u18/web-ui` の `page-headers.ts` を
  // 読んだ人は **#226 で直っていると思う** —— あのファイルのコメントは
  // auth-worker の話で、こちらには効いていない。
  //
  // **ここが効く場所である。** 画面側（`pageSecurityHeaders`）に書いても、
  // この全体ミドルウェアが後から上書きするので効かない（auth-worker の
  // `app.ts` と同じ。向こうは実際にそれで一度失敗している）。
  //
  // `same-origin` なら同一オリジンへの要求にだけ参照元が載る。外部サイトへは
  // 何も送らない。この Worker は `auth.under18.dev/account/*` だけを受け持ち、
  // 外部への遷移を持たないので、失うものは無い。
  root.use("*", secureHeaders({ referrerPolicy: "same-origin" }));

  // **キャッシュさせないのを既定にする（#125 / RR-10）。**
  //
  // この Worker が返すのは全部 auth-worker から中継した個人情報
  // （プロフィール・セッション一覧・同意済みアプリ）である。
  // 中間プロキシやブラウザに残ると、共用端末で前の利用者の情報が戻る。
  //
  // **例外が 1 つある。** スタイルシートとアイランド JS は
  // `IMMUTABLE_ASSET_CACHE_CONTROL` で上書きする（`ui/account.routes.tsx`）。
  // URL に内容ハッシュが入っているので永久に持たせてよく、中身は全利用者に
  // 同じで個人情報を 1 文字も含まない。`test/cache-control.test.ts` が
  // 「例外はこれだけ」を固定している。
  //
  // **ここには長らく「意図的に違う値を使う経路は 1 つも無い」と書いて
  // あった。** 書かれた時点から事実ではなく、アセットは当時も
  // `public, max-age=300` で上書きしていた。#211 でその値が `immutable`
  // に変わり、嘘がより強くなったところで気づかれた。
  //
  // **動作は正しかった。壊れていたのは次に読む人の判断である** ——
  // この Worker にキャッシュの例外を足そうとした人は、ここを読んで
  // 「全経路一律だから個別に上書きする場所は無いはず」と考え、
  // **既に 1 つあることに気づかない。** #228 と同じ形（あちらは
  // 「`Referrer-Policy` を `no-referrer` のままにしない」と書いてある
  // ファイルが、実際には設定していなかった）。
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
   * 以降のルートはすべて接頭辞付きの router に登録する（理由は
   * `base-path.ts` を参照）。
   *
   * `basePath()` が返すのは router を共有した別インスタンスなので、
   * `root` に付けたミドルウェアはそのまま効く。**新しいエンドポイントを
   * 足すときは必ず `registerRoutes` のチェーンに足すこと。** `root` に
   * 直接足すと、本番で到達不能なエンドポイントが 1 つ増える。
   */
  registerRoutes(root.basePath(ACCOUNT_BASE_PATH));

  /**
   * HTML を返す画面（#9）。`/account`・`/account/sessions`・`/account/grants`
   * と、そこから読むスタイルシート。
   *
   * **API のチェーンには混ぜない。** `registerRoutes` のチェーンは
   * `hono/client` に渡す型を作るためのもので、`c.html()` を返す画面を
   * そこへ積んでも意味が無い（ブラウザが直接開くので `hc` から呼ばない）。
   * 型を読む人にとっても雑音になる。
   *
   * 取得は JSON の経路と**同じ `IdentityGateway`**（ミドルウェアで入る）。
   * ページ用に別の取得経路を作ると、片方だけ認可が緩む余地ができる。
   */
  root.basePath(ACCOUNT_BASE_PATH).route("/", accountUiRoutes);

  // 返すのは `root`。`basePath()` の戻り値は `root` の router を共有して
  // いるので、上で登録したハンドラはすべてここから引ける。
  return root;
}
