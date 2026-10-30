/**
 * この Worker が載っているパス。
 *
 * **`app.ts` から分けてある。** アセットのパス（`ui/asset-paths.ts`）が
 * これを要るが、`app.ts` は `ui/` 側を import するので、そのままだと
 * 循環する。dashboard-worker が `base-path.ts` を分けているのと同じ理由。
 */

/**
 * 管理 API のベースパス。
 *
 * **auth-worker と同一ホストの `/account/nfc/*` に載せる。**
 *
 * セッション Cookie は `__Host-` 接頭辞を使っており、Domain 属性を
 * 付けられない = 発行したホストにしか送られない
 * （`packages/contracts/src/session-cookie.ts`）。
 * 管理 API を `go.under18.dev` に置くと、ログイン済みのブラウザから
 * Cookie が届かず、永久に 401 になる。短縮 URL のホストと
 * 管理画面のホストを分ける判断は、ここで決まっている。
 *
 * dashboard-worker が `auth.under18.dev/account/*` を取っているため、
 * route の衝突に注意すること（wrangler.jsonc に詳述）。
 */
export const CARDS_BASE_PATH = "/account/nfc/cards";

/** カード一覧の画面。API（`CARDS_BASE_PATH`）とは別のパスに置く。 */
export const CARDS_UI_PATH = "/account/nfc";

/**
 * 未紐づけのカードをタップした人が着地する画面（#358）。
 *
 * **`CARDS_UI_PATH` の下に置く。** auth-worker の `sanitizeReturnTo` が
 * 許すのは `/oauth/authorize` と `/account` で始まるパスだけなので、
 * ここに置く限り**戻り先の許可リストに何も足さずに済む**
 * （あちらの「先回りして広げない」）。
 */
export const CLAIM_UI_PATH = `${CARDS_UI_PATH}/claim`;

/**
 * 紐づけ画面にカード ID を渡すクエリ名。
 *
 * ## **パスではなくクエリに置く。これは安全側の判断である**
 *
 * `/account/nfc/claim/<cardId>` と書きたくなるが、採らない。
 * `@u18/web-ui` の `isValidCsrf` は拒否のログに
 * **`new URL(c.req.url).pathname` を書き、`search` は意図的に落としている**
 * （トークンの値を書かないのと同じ方針）。`observability` は有効である。
 *
 * **#358 でカード ID の性質が変わった。** 以前は URL に出ても無害だった ——
 * 紐づけには別に紐づけコードが要ったからである。いまは **ID を知って
 * いれば未紐づけのカードを取れる**ので、**ログ 1 行が持ち出しになる。**
 *
 * **何も壊れていないのに危険になった**形である。`isValidCsrf` の
 * 書き方は正しく、その正しさが**カード ID をパスに置いた瞬間に裏返る。**
 * REST らしさのためにパスへ戻さないこと。
 */
export const CLAIM_CARD_PARAM = "card";

/**
 * 紐づけ画面の絶対 URL を組み立てる。
 *
 * **絶対 URL でなければならない。** タップを受けるのは `go.under18.dev`、
 * 紐づけ画面は `auth.under18.dev`（開発では同じ Worker の別パス）で、
 * **オリジンが違う。** `origin` は `ACCOUNT_ORIGIN` を渡すこと。
 */
export function claimUrl(accountOrigin: string, cardId: string): string {
  const url = new URL(CLAIM_UI_PATH, accountOrigin);
  url.searchParams.set(CLAIM_CARD_PARAM, cardId);
  return url.toString();
}

/**
 * カードを受け取った人向けの案内（#358）。
 *
 * ## `go.under18.dev/docs` である。`auth.under18.dev` ではない
 *
 * `wrangler.jsonc` の production route は `go.under18.dev/*` でホスト全体を
 * 受けるので、**このパスは短縮 URL のホストから届く。** auth 側の route は
 * `/account/nfc` とその下だけなので、`auth.under18.dev/docs` は
 * auth-worker へ行く（こちらには来ない）。
 *
 * **カードに書いてあるのが `go.under18.dev` なので、案内も同じホストに置く。**
 * タップした人がドメインを見て「ここは何だ」と思ったときに、
 * **同じホストの `/docs` が答えになる。**
 *
 * ## 認証しない
 *
 * `/c/:cardId` と同じ性質を保つ —— **Cookie を読まないし発行もしない。**
 * カードを拾っただけの人も、まだ登録していない人も読める。
 */
export const DOCS_PATH = "/docs";
