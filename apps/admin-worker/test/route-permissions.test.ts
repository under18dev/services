import { describe, expect, it } from "vitest";
import { ROUTE_PERMISSIONS } from "../src/presentation/http/route-permissions";
import {
  NAV_ACTION_ROUTES,
  NAV_PAGE_ROUTES,
  PENDING_ROUTES,
  PUBLIC_ROUTES,
  ROOT_ROUTES,
} from "./route-inventory";

/**
 * `ROUTE_PERMISSIONS`（#190）が、操作ルートの全件を覆っていること。
 *
 * **二方向で見る**（`route-inventory.test.ts` と同じ形）。
 *
 * - `NAV_PAGE_ROUTES` / `NAV_ACTION_ROUTES` の全件が `ROUTE_PERMISSIONS` に
 *   居ること——ここが抜けると、新しいルートが権限チェック無しで通ってしまう
 *   わけではなく、むしろ逆に実行時は「対応表に無い」として 403 になる
 *   （`app.tsx` の既定拒否）。だが CI で先に気づけたほうが安い
 * - `ROUTE_PERMISSIONS` に実在しないルート（綴りミス・消したルートの
 *   残骸）が残っていないこと——残っていると、二度と 403 にならない
 *   「宣言されているが実在しない」エントリが静かに蓄積する
 *
 * `PUBLIC_ROUTES` / `ROOT_ROUTES` / `PENDING_ROUTES` は対象外
 * （`route-permissions.ts` 冒頭のコメントと同じ理由——「承認されているか」
 * だけで決まり、操作ごとの権限を問わない）。
 */
describe("ROUTE_PERMISSIONS が操作ルートの全件を覆う", () => {
  const operationRoutes = [...NAV_PAGE_ROUTES, ...NAV_ACTION_ROUTES].map(
    (route) => `${route.method} ${route.path}`,
  );
  const declared = Object.keys(ROUTE_PERMISSIONS);

  it("1 件以上ある（読み取りが効いていないだけで 0 件になっていないか）", () => {
    expect(operationRoutes.length).toBeGreaterThan(0);
    expect(declared.length).toBeGreaterThan(0);
  });

  it("NAV_PAGE_ROUTES / NAV_ACTION_ROUTES の全件が ROUTE_PERMISSIONS に居る", () => {
    const missing = operationRoutes.filter((route) => !declared.includes(route));
    expect(missing).toEqual([]);
  });

  it("ROUTE_PERMISSIONS に、実在しないルートが残っていない", () => {
    const stale = declared.filter((route) => !operationRoutes.includes(route));
    expect(stale).toEqual([]);
  });

  it("対象外のルート（PUBLIC_ROUTES / ROOT_ROUTES / PENDING_ROUTES）は宣言しない", () => {
    const exempt = [...PUBLIC_ROUTES, ...ROOT_ROUTES, ...PENDING_ROUTES].map(
      (route) => `${route.method} ${route.path}`,
    );
    const wronglyDeclared = declared.filter((route) => exempt.includes(route));
    expect(wronglyDeclared).toEqual([]);
  });
});
