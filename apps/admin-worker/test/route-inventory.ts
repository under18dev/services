/**
 * この Worker が持つルートの一覧。**手で書く**（#275 / dashboard-worker と同じ形）。
 *
 * ## なぜ要るのか
 *
 * `check-app-catalog-routes.mjs` は `ADMIN_NAV_GROUPS`（`nav.ts`）の `href` が
 * `admin.under18.dev` の production route に届くことまでは見るが、**届いた先の
 * admin-worker が実際にそのパスを登録しているか**は、この一覧が無ければ
 * 誰も突き合わせていなかった（#427）。いまは一致しているが、どちらかが
 * 動いても検査が気づかない——#338 と同じ形の、まだ開いていない穴だった。
 *
 * ## 区分の分け方
 *
 * - `PUBLIC_ROUTES`: ログイン前からセッション無しで叩ける（OIDC のやり取りと
 *   死活確認）。
 * - `PENDING_ROUTES`: ログイン済みだが承認待ちの人を送る先。
 * - `NAV_ROUTES`: `ADMIN_NAV_GROUPS` に出ている 4 画面とその更新系。承認済みの
 *   管理者だけが使う。
 *
 * ルートを足したら、ここにも 1 行足すこと。足さないと
 * `route-inventory.test.ts` が落ちる。
 */

type Route = { readonly method: string; readonly path: string };

/** OIDC のやり取りと死活確認。セッション Cookie を前提にしない。 */
export const PUBLIC_ROUTES: readonly Route[] = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/login" },
  { method: "GET", path: "/callback" },
  { method: "GET", path: "/logout" },
];

/**
 * 入口。セッションの有無・承認の有無で `/login` か `/pending` かへ
 * 振り分けるだけで、それ自体は画面を持たない。
 */
export const ROOT_ROUTES: readonly Route[] = [{ method: "GET", path: "/" }];

/** ログイン済みだが承認待ちの人を送る先（#390 決定 3）。 */
export const PENDING_ROUTES: readonly Route[] = [{ method: "GET", path: "/pending" }];

/** `ADMIN_NAV_GROUPS`（`ui/nav.ts`）に出ている 4 画面。 */
export const NAV_PAGE_ROUTES: readonly Route[] = [
  { method: "GET", path: "/nfc" },
  { method: "GET", path: "/clients" },
  { method: "GET", path: "/users" },
  { method: "GET", path: "/audit" },
];

/** 上の画面から呼ぶ更新系・検索系。 */
export const NAV_ACTION_ROUTES: readonly Route[] = [
  { method: "POST", path: "/nfc" },
  /**
   * batch 単位の一括無効化（#427）。**この 1 本が 2 つの意味を持つ。**
   * `target_batch` が空なら 1 段階目（対象枚数を数えるだけ、書き込まない）、
   * 入っていれば 2 段階目（再入力が一致すれば実際に無効化する）——
   * フォームの `action` が同じなので、一覧には 1 行しか出てこない。
   */
  { method: "POST", path: "/nfc/batch-disable" },
  /** `/nfc/batch-disable` の逆（#436）。同じ理由で 1 本が 2 段階を兼ねる。 */
  { method: "POST", path: "/nfc/batch-reinstate" },
  { method: "POST", path: "/nfc/:cardId/disable" },
  { method: "POST", path: "/nfc/:cardId/release" },
  { method: "POST", path: "/nfc/:cardId/reinstate" },
  { method: "POST", path: "/nfc/:cardId/target" },
  { method: "POST", path: "/clients" },
  { method: "POST", path: "/clients/disable" },
  { method: "POST", path: "/users/search" },
  { method: "POST", path: "/users/:userId/suspend" },
  { method: "POST", path: "/users/:userId/reinstate" },
  { method: "POST", path: "/users/:userId/revoke-sessions" },
  { method: "POST", path: "/audit/search" },
];

/** 実行時に登録されているべきもの全部。 */
export const EXPECTED_ROUTES: readonly Route[] = [
  ...PUBLIC_ROUTES,
  ...ROOT_ROUTES,
  ...PENDING_ROUTES,
  ...NAV_PAGE_ROUTES,
  ...NAV_ACTION_ROUTES,
];
