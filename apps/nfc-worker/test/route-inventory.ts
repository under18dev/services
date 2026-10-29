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
 * カード管理。**`auth.under18.dev/account/nfc/*` に載せてある。**
 *
 * セッション Cookie が要るので、`go.under18.dev` 経由では 401 になる。
 * **ただし届いてはいる** —— 認証で止まっているだけで、公開面としては
 * 2 ホストに開いている。
 */
export const CARD_ROUTES: readonly Route[] = [
  // 画面。
  { method: "GET", path: "/account/nfc" },
  // 画面が読むスタイルシート。**auth-worker から借りるのをやめた**（#211）。
  { method: "GET", path: "/account/nfc/ui/u18.<hash>.css" },

  // 管理 API。
  { method: "GET", path: "/account/nfc/cards" },
  { method: "POST", path: "/account/nfc/cards" },
  { method: "POST", path: "/account/nfc/cards/claim" },
  { method: "PUT", path: "/account/nfc/cards/:cardId/target" },
  { method: "POST", path: "/account/nfc/cards/:cardId/disable" },
  { method: "POST", path: "/account/nfc/cards/:cardId/release" },
];

/** 実行時に登録されているべきもの全部。 */
export const EXPECTED_ROUTES: readonly Route[] = [
  ...REDIRECT_ROUTES,
  ...HEALTH_ROUTES,
  ...CARD_ROUTES,
];
