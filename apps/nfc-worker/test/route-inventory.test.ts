import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { CARD_ROUTES, EXPECTED_ROUTES, HEALTH_ROUTES, REDIRECT_ROUTES } from "./route-inventory";

/**
 * 登録されているルートが `route-inventory.ts` の一覧と一致すること（#275）。
 *
 * **この Worker は 2 つのホストに載っている。** `go.under18.dev/*` が全パスを
 * 拾うので、ここに並ぶ全部が短縮 URL のホストからも叩ける（#280）。
 * **「足したルートは `go.under18.dev` からも叩けてよいか」**を考える場所が
 * この一覧である。
 */
describe("公開面の一覧", () => {
  /** アセットの URL には内容ハッシュが入る（#211）。16 進 16 文字を伏せる。 */
  const normalize = (path: string): string => path.replace(/\.[0-9a-f]{16}\./g, ".<hash>.");

  const actual = [
    ...new Set(
      createApp()
        .routes.filter((route) => route.method !== "ALL")
        .map((route) => `${route.method} ${normalize(route.path)}`),
    ),
  ];

  const expected = EXPECTED_ROUTES.map((route) => `${route.method} ${route.path}`);

  it("一覧に無いルートが登録されていない", () => {
    expect(actual.filter((route) => !expected.includes(route))).toEqual([]);
  });

  it("一覧にあるルートがすべて登録されている", () => {
    expect(expected.filter((route) => !actual.includes(route))).toEqual([]);
  });

  it("区分が重なっていない", () => {
    const all = [...REDIRECT_ROUTES, ...HEALTH_ROUTES, ...CARD_ROUTES].map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(all.length).toBe(new Set(all).size);
  });

  it("どの区分も空でない", () => {
    // **空の配列は `filter` しても `every` しても緑になる。** 0 件ガード。
    for (const [name, routes] of [
      ["REDIRECT_ROUTES", REDIRECT_ROUTES],
      ["HEALTH_ROUTES", HEALTH_ROUTES],
      ["CARD_ROUTES", CARD_ROUTES],
    ] as const) {
      expect(routes.length, `${name} が空`).toBeGreaterThan(0);
    }
  });
});
