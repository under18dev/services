/**
 * この Worker が外に見せているものの一覧。**手で書く**（#275）。
 *
 * ## auth-worker の一覧と違うところ
 *
 * **nfc-worker は 2 つのホストに載っている。** `wrangler.jsonc` の route は:
 *
 * ```
 * go.under18.dev/*                     <- 全パスが届く
 * auth.under18.dev/account/nfc
 * auth.under18.dev/account/nfc/*
 * ```
 *
 * **`go.under18.dev/*` なので、ここに並ぶ全部が短縮 URL のホストからも
 * 叩ける。** カード管理の経路も `/health` もそうである（実測、#280）。
 *
 * 漏れてはいない —— セッション Cookie は `__Host-` 接頭辞で
 * `auth.under18.dev` にしか送られないので、`go.under18.dev` 経由では
 * 常に未認証になる。**だが「どちらのホストから何が見えるか」は、この
 * 一覧でしか確かめられない。**
 *
 * ## これが落ちたら
 *
 * **まず一覧のほうを直す。** そのうえで「足したルートは `go.under18.dev`
 * からも叩けてよいか」を考える —— それがこの Worker に固有の問いである。
 */

type Route = { readonly method: string; readonly path: string };

/**
 * 短縮 URL の解決。**この Worker の存在理由。**
 *
 * `go.under18.dev/c/<id>` で叩かれる。未認証で誰でも叩ける。
 */
export const REDIRECT_ROUTES: readonly Route[] = [{ method: "GET", path: "/c/:cardId" }];

/**
 * 死活確認。
 *
 * **`go.under18.dev/health` で叩ける**（#280）。`deploy.yml` は
 * 「どの route にも当たらず外から叩けない」と書いているが、**実測では
 * 200 が返る。** 文書のほうが実態と食い違っている。
 */
export const HEALTH_ROUTES: readonly Route[] = [{ method: "GET", path: "/health" }];

/**
 * カードを受け取った人向けの案内（#358）。
 *
 * **`go.under18.dev` に HTML を置くのは、これが初めてである。** それまで
 * あのホストが返していたのは 302 と素のテキスト（404）だけだった。
 *
 * **認証しない。** `/c/:cardId` と同じ性質で、Cookie を読まないし発行も
 * しない —— **読めなければ案内の意味が無い。** 下の検査が実際に
 * Cookie 無しで 200 が返ることを確かめている。
 *
 * **`auth.under18.dev/docs` はこちらに来ない。** あちらの route は
 * `/account/nfc` とその下だけで、`/docs` は auth-worker が受ける。
 *
 * スタイルシートは**カード画面のものを借りていない。** 中身は同じで
 * ハッシュも同じなので借りれば 200 になるが、**それが #310 で踏んだ形**
 * である（`ui/asset-paths.ts`）。接頭辞を厳密に持つと、公開面を数える
 * 側から「案内が読むもの」と「カード画面が読むもの」が別に見える。
 */
export const DOCS_ROUTES: readonly Route[] = [
  { method: "GET", path: "/docs" },
  { method: "GET", path: "/docs/ui/kiwa.<hash>.css" },
];

/**
 * カード管理の API。**`auth.under18.dev/account/nfc/*` に載せてある。**
 *
 * **セッション Cookie が要る。** 無ければ 401 の JSON を返す
 * （`cards.routes.ts`）。`go.under18.dev` 経由では `__Host-` の Cookie が
 * 送られないので常に 401 になる —— **ただし届いてはいる。** 認証で
 * 止まっているだけで、公開面としては 2 ホストに開いている。
 *
 * この区分は**下の検査が実際に 401 を確かめている。** 取り違えて載せると
 * その場で落ちる。
 */
export const CARD_API_ROUTES: readonly Route[] = [
  { method: "GET", path: "/account/nfc/cards" },
  { method: "POST", path: "/account/nfc/cards" },
  { method: "POST", path: "/account/nfc/cards/claim" },
  { method: "PUT", path: "/account/nfc/cards/:cardId/target" },
  { method: "POST", path: "/account/nfc/cards/:cardId/disable" },
  { method: "POST", path: "/account/nfc/cards/:cardId/release" },
];

/**
 * カード管理の画面。
 *
 * **401 ではなく 302 である。** 画面で JSON を見せても利用者にできることが
 * 無いので `/login?return_to=...` へ送る（`cards-ui.routes.tsx`）。
 *
 *     https://auth.under18.dev/account/nfc
 *       -> 302 https://auth.under18.dev/login?return_to=%2Faccount%2Fnfc
 *
 * **長らく API と同じ区分に入れて「401 になる」と書いてあった。**
 * 守られてはいるが、**返るものが違う。**
 */
export const CARD_PAGE_ROUTES: readonly Route[] = [{ method: "GET", path: "/account/nfc" }];

/**
 * 運営向けのカード管理画面（#338 Step 3）。
 *
 * **区分を分けてあるのは、Cookie 無しの応答が同じでも、
 * Cookie 有りの応答が違うからである。**
 *
 * | | Cookie 無し | 一般利用者 | 管理者 |
 * | --- | --- | --- | --- |
 * | `GET /account/nfc/admin` | **302**（ログインへ） | **404** | 200 |
 *
 * **一般利用者に 403 を返さない。** 403 は「在るが権限が無い」と読めるので、
 * 管理画面の所在を教える（#331 / #333 の判断）。`cards-ui.routes.tsx` が
 * `forbidden` を 404 に翻訳している。
 */
export const CARD_ADMIN_ROUTES: readonly Route[] = [{ method: "GET", path: "/account/nfc/admin" }];

/**
 * カードをタップした人が着地する紐づけ画面（#358）。
 *
 * **区分を分けてあるのは、応答が上の 2 つのどちらとも違うからである。**
 *
 * | | Cookie 無しのとき |
 * | --- | --- |
 * | `GET /account/nfc/claim` | **302**（`CARD_PAGE_ROUTES` と同じ） |
 * | `POST /account/nfc/claim` | **400**（CSRF で先に落ちる。401 でも 302 でもない） |
 *
 * POST が 400 なのは、**CSRF の検証がセッションの検証より先**にあるため。
 * 順序はこれで正しい —— トークンを確かめる前に D1 や Identity を引かない。
 * **`CARD_API_ROUTES`（401）に混ぜると、下の検査がその場で落ちる。**
 *
 * **この Worker で唯一の form POST である。** 2 本目を足す人は、
 * dashboard-worker の `test/form-csrf.test.ts`（src を走査して guard を
 * 通っていない form を落とす）を先に移植すること（`http/csrf.ts`）。
 *
 * **`go.under18.dev` からも届く。** そちらでは `__Host-` の Cookie が
 * 送られないので、GET はログインへ送られ、POST は CSRF で落ちる。
 */
export const CARD_CLAIM_ROUTES: readonly Route[] = [
  { method: "GET", path: "/account/nfc/claim" },
  { method: "POST", path: "/account/nfc/claim" },
];

/**
 * 画面が読むスタイルシート。**セッションを要求しない。**
 *
 * **これは公開アセットである。** `registerCardsUiRoutes` は
 * このパスに認証を一切掛けておらず、**2 つのホストのどちらからも
 * Cookie 無しで 200 が返る**（実測）:
 *
 *     https://auth.under18.dev/account/nfc/ui/kiwa.<hash>.css  200
 *     https://go.under18.dev/account/nfc/ui/kiwa.<hash>.css    200
 *
 * **意図どおりである** —— 中身は全利用者に同じ CSS で、個人情報を
 * 1 文字も含まない（`cards-ui.routes.tsx` のコメント）。`immutable` で
 * 配信するのもそのため。
 *
 * **長らく「セッション Cookie が要る」と書かれた区分の中にあった。**
 * 公開面を数える側から見ると、**開いているものが閉じていることに
 * なっていた。**
 */
export const CARD_ASSET_ROUTES: readonly Route[] = [
  { method: "GET", path: "/account/nfc/ui/kiwa.<hash>.css" },
  // 遷移先の変更のアイランド（#338）。CSS と同じく公開アセットで、
  // セッションを要求しない —— 中身は全利用者に同じスクリプトである
  // （カード ID は HTML 側の `data-card-id` から読む）。
  { method: "GET", path: "/account/nfc/ui/cards-island.<hash>.js" },
];

/** カード管理に属するもの全部。一覧の突き合わせに使う。 */
/**
 * **本番のアセット検査には載っていない**（`UNPROBEABLE`）。
 *
 * カード画面 `/account/nfc` は未ログインで 302 を返すので、外から参照を
 * 読めない。理由は `scripts/lib/asset-probe-pages.mjs` の `UNPROBEABLE`。
 *
 * **そのぶん `asset-coverage.test.ts` が代わりを務める。** あちらは
 * テスト内でレンダリングするのでセッションを作れる —— **外からの検査では
 * 閉じられなかった穴が、この向きだと閉じる**（#313）。
 */
export const PROBE_PAGES: readonly string[] = [];

export const CARD_ROUTES: readonly Route[] = [
  ...CARD_PAGE_ROUTES,
  ...CARD_ADMIN_ROUTES,
  ...CARD_CLAIM_ROUTES,
  ...CARD_ASSET_ROUTES,
  ...CARD_API_ROUTES,
];

/** 実行時に登録されているべきもの全部。 */
export const EXPECTED_ROUTES: readonly Route[] = [
  ...REDIRECT_ROUTES,
  ...HEALTH_ROUTES,
  ...DOCS_ROUTES,
  ...CARD_ROUTES,
];
