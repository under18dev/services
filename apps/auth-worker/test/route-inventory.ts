/**
 * この Worker が外に見せているものの一覧。**手で書く。**
 *
 * ## なぜ要るのか
 *
 * **auth-worker はこのシステムで最も公開面が広い。** OIDC のエンドポイント、
 * ログイン画面、JSON API、静的アセット —— どれも外から叩ける。にもかかわらず、
 * **ルートが 1 本増えても既存のテストは全部通る。**
 *
 * 足すこと自体は意図的でも、**「この Worker が外に何を見せているか」を
 * 一覧で確かめる機会が無かった**（#275）。公開面に関する欠陥は今日だけで
 * 3 つ出ている:
 *
 * | | 何が起きたか |
 * | --- | --- |
 * | #217 | 裸の接頭辞が 404（route パターンの側） |
 * | #264 | `/login/options` に制限が無く、誰でも行を作れた |
 * | #97 | `/health` がどの route にも当たらず外から叩けない |
 *
 * **どれも「このルートは何を公開しているか」を一覧で見ていれば気づけた形**
 * である。
 *
 * ## dashboard-worker の一覧とは目的が違う
 *
 * あちらは **`hono/client` のチェーンに乗っているか**を見る（#188）。
 * auth-worker に `hc` クライアントは無いので、**ここは公開面の棚卸しだけ**
 * を目的にしている。
 *
 * ## これが落ちたら
 *
 * **まず一覧のほうを直す。** そのうえで「足したルートは本当に外へ出して
 * よいか」を考える —— 認証は要るか、レート制限は掛かるか、`Cache-Control`
 * は何か。**落ちること自体が目的で、落ちたときに考える場所がここである。**
 */

type Route = { readonly method: string; readonly path: string };

/** 誰でも叩ける。**増やすときは、なぜ公開してよいかを考えること。** */
export const PUBLIC_ROUTES: readonly Route[] = [
  // 死活確認。#97 で「どの route にも当たらず外から叩けない」を踏んだので、
  // wrangler.jsonc の route と対で見ること。
  { method: "GET", path: "/health" },

  // OIDC の公開メタデータ。仕様が公開を必須にしている（決定 10）。
  { method: "GET", path: "/.well-known/openid-configuration" },
  { method: "GET", path: "/.well-known/jwks.json" },

  // 画面。未ログインで開ける。
  { method: "GET", path: "/login" },
  { method: "GET", path: "/signup" },

  // 静的アセット。**URL に内容ハッシュが入る**（#211）ので、照合側で
  // `<hash>` に正規化している。
  { method: "GET", path: "/ui/u18.<hash>.css" },
  { method: "GET", path: "/ui/login-island.<hash>.js" },

  // form 経路（JS 無しで完結する）。CSRF トークンと Origin の二重で守る。
  { method: "POST", path: "/login/start" },
  { method: "POST", path: "/login/verify" },
  { method: "POST", path: "/login/logout" },
  { method: "POST", path: "/signup/start" },
  { method: "POST", path: "/signup/verify" },

  // JSON API。**アカウントの有無を漏らさない**ことが設計の中心（仕様書 9）。
  { method: "POST", path: "/api/auth/email/start" },
  { method: "POST", path: "/api/auth/email/verify" },
  { method: "POST", path: "/api/auth/logout" },

  // Passkey のログイン。**options は入力を取らない**ので列挙できない（決定 13）。
  // ただし行を作るので IP 制限が要る（#264）。
  { method: "POST", path: "/api/auth/passkeys/login/options" },
  { method: "POST", path: "/api/auth/passkeys/login/verify" },
];

/** セッション Cookie が要る。 */
export const SESSION_ROUTES: readonly Route[] = [
  { method: "GET", path: "/api/me" },
  { method: "PATCH", path: "/api/me" },
  { method: "GET", path: "/api/me/sessions" },
  { method: "DELETE", path: "/api/me/sessions/:id" },
  { method: "GET", path: "/api/me/passkeys" },
  { method: "DELETE", path: "/api/me/passkeys/:id" },

  // 認証器の登録。ログイン済みでなければ始められない。
  { method: "POST", path: "/api/auth/passkeys/register/options" },
  { method: "POST", path: "/api/auth/passkeys/register/verify" },
];

/**
 * OAuth / OIDC の経路。
 *
 * **ここだけ「誰が叩くか」が 2 通りある** —— ブラウザ（authorize / consent）と
 * RP のサーバ（token / revoke / userinfo）。レート制限の鍵が分かれているのも
 * そのためで、`RL_OAUTH_CLIENT` だけ `<client_id>:<ipHash>` になる。
 */
export const OAUTH_ROUTES: readonly Route[] = [
  { method: "GET", path: "/oauth/authorize" },
  { method: "POST", path: "/oauth/consent" },
  { method: "POST", path: "/oauth/token" },
  { method: "POST", path: "/oauth/revoke" },
  { method: "GET", path: "/oauth/userinfo" },
  { method: "POST", path: "/oauth/userinfo" },
];

/** 実行時に登録されているべきもの全部。 */
/** ハッシュ付きアセット。`PUBLIC_ROUTES` から導く（別に書かない）。 */
export const ASSET_ROUTES: readonly Route[] = PUBLIC_ROUTES.filter((route) =>
  route.path.includes("/ui/"),
);

/**
 * **本番のアセット検査が引くページ**（`scripts/smoke-asset-probe.sh` の
 * `probe_pages_for`）。
 *
 * **あちらと一致していなければならない。** `check-asset-probe-pages.mjs` が
 * 両者を突き合わせている。参照の有無をレンダリングで確かめられるのは
 * Worker のテスト側だけで（workerd 上のテストからリポジトリのファイルは
 * 読めない。実測）、そちらがこの一覧を見ているため。
 *
 * `/login` 1 枚で CSS とアイランドの両方を参照している
 * （`asset-coverage.test.ts` が確かめる）。
 */
export const PROBE_PAGES: readonly string[] = ["/login"];

export const EXPECTED_ROUTES: readonly Route[] = [
  ...PUBLIC_ROUTES,
  ...SESSION_ROUTES,
  ...OAUTH_ROUTES,
];
