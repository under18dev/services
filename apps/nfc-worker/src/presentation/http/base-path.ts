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
