/**
 * ルート → 必要な権限の対応表（#190）。
 *
 * **判定は 1 箇所に集める。** ルートごとに `if` を散らさず、ここに書いた
 * ものだけを `app.tsx` のガードが見る。`test/route-permissions.test.ts` が
 * `test/route-inventory.ts` の `NAV_PAGE_ROUTES` / `NAV_ACTION_ROUTES` と
 * ここを二方向で突き合わせる（`route-inventory.test.ts` と同じ形）——
 * 宣言の無いルートを足せない。
 *
 * **`PUBLIC_ROUTES` / `ROOT_ROUTES` / `PENDING_ROUTES` はここに出てこない。**
 * あれらは「承認されているか」だけで決まり、操作ごとの権限を問わない
 * （`/` はホームの概要で、個別の操作を行わない）。
 *
 * キーは `"METHOD path"`——`route-inventory.ts` の `Route` と同じパスの
 * 書き方（`:cardId` 等のパラメータはそのまま）。実行時は Hono が解決した
 * パターン（`routePath(c, -1)`、生のリクエストパスではない）で引く。
 *
 * **粒度は「画面」ではなく「操作」。** 検索・一覧は対応する `_READ`、
 * 書き込みを伴う操作は `_WRITE` または専用のビット（`USER_SUSPEND`）。
 */
import { PERMISSION_BITS, type PermissionBitName } from "../../domain/permissions";

export const ROUTE_PERMISSIONS: Readonly<Record<string, PermissionBitName>> = {
  "GET /nfc": "NFC_READ",
  "GET /clients": "CLIENT_READ",
  "GET /users": "USER_READ",
  "GET /audit": "AUDIT_READ",

  "POST /nfc": "NFC_WRITE",
  "POST /nfc/batch-disable": "NFC_WRITE",
  "POST /nfc/batch-reinstate": "NFC_WRITE",
  "POST /nfc/:cardId/disable": "NFC_WRITE",
  "POST /nfc/:cardId/release": "NFC_WRITE",
  "POST /nfc/:cardId/reinstate": "NFC_WRITE",
  "POST /nfc/:cardId/reinstate-to-issued": "NFC_WRITE",
  "POST /nfc/:cardId/target": "NFC_WRITE",

  "POST /clients": "CLIENT_WRITE",
  "POST /clients/disable": "CLIENT_WRITE",
  // #441。main に先に入ったので最終合わせを待たずここで足す
  // （#454/#455 等、まだ並行中のものは最後にまとめて合わせる）。
  "POST /clients/owner": "CLIENT_WRITE",

  // 検索は読み取り。一覧の絞り込みでしかなく、状態を変えない。
  "POST /users/search": "USER_READ",
  "POST /users/:userId/suspend": "USER_SUSPEND",
  "POST /users/:userId/reinstate": "USER_SUSPEND",
  "POST /users/:userId/revoke-sessions": "USER_SUSPEND",

  "POST /audit/search": "AUDIT_READ",

  // 承認者・権限の管理画面（#190）。
  "GET /approvals": "APPROVAL_GRANT",
  "POST /approvals/:sub/super": "APPROVAL_GRANT",
  "POST /approvals/:sub/permissions": "APPROVAL_GRANT",
  "POST /approvals/:sub/revoke": "APPROVAL_GRANT",
} as const satisfies Readonly<Record<string, PermissionBitName>>;

/** `routePath(c, -1)` の結果から、要求するビットを引く。 */
export function requiredPermissionFor(method: string, routePath: string): bigint | undefined {
  const name = ROUTE_PERMISSIONS[`${method} ${routePath}`];
  return name === undefined ? undefined : PERMISSION_BITS[name];
}
