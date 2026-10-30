/**
 * admin-worker のサイドバーの並び（#390 決定 16 ③）。
 *
 * **`@u18/contracts` の `ACCOUNT_NAV_GROUPS` とは別物。** あちらは
 * `/account/*`（dashboard-worker / nfc-worker）の並びで、`AccountNavKey`
 * という閉じた共用体に縛られている。admin-worker は別オリジンの別アプリ
 * なので、同じ共用体に項目を足すと `check-app-catalog-routes.mjs` が
 * `/account` 配下として解決しようとして壊れる。
 *
 * `KiwaShell` の `nav`/`current` は `ShellNavGroup`/`ShellNavCurrent`
 * （構造的な型）になっているので、ここで独自の配列を持てる
 * （`packages/web-ui/src/kiwa/shell.tsx` の冒頭を参照）。
 */
import type { ShellNavGroup } from "@u18/web-ui/kiwa";

export const ADMIN_NAV_GROUPS: readonly ShellNavGroup[] = [
  {
    label: "管理",
    items: [
      { key: "nfc", href: "/nfc", label: "NFC カード" },
      { key: "clients", href: "/clients", label: "OAuth クライアント" },
      { key: "users", href: "/users", label: "利用者" },
      { key: "auditLogs", href: "/audit", label: "監査ログ" },
    ],
  },
];
