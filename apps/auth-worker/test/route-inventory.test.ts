import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { EXPECTED_ROUTES, OAUTH_ROUTES, PUBLIC_ROUTES, SESSION_ROUTES } from "./route-inventory";

/**
 * 登録されているルートが `route-inventory.ts` の一覧と一致すること（#275）。
 *
 * **これが落ちたら、まず一覧のほうを直す。** そのうえで「足したルートは
 * 本当に外へ出してよいか」を考える。**落ちること自体が目的である。**
 */
describe("公開面の一覧", () => {
  /**
   * アセットの URL には内容ハッシュが入る（#211）。手で書けないので、
   * 一覧側は `<hash>` と書いてある。**16 進 16 文字の塊だけを伏せる**ので、
   * ハッシュが入らなくなればここで一致しなくなる。
   */
  const normalize = (path: string): string => path.replace(/\.[0-9a-f]{16}\./g, ".<hash>.");

  // `ALL /*` はミドルウェア。見たいのはエンドポイントだけ。
  //
  // **重複を畳んでから比べる。** Hono は `.get(path, middleware, handler)` の
  // ようにハンドラを複数渡すと `app.routes` へ同じ method+path を
  // ハンドラの数だけ積む。
  const actual = [
    ...new Set(
      createApp()
        .routes.filter((route) => route.method !== "ALL")
        .map((route) => `${route.method} ${normalize(route.path)}`),
    ),
  ];

  const expected = EXPECTED_ROUTES.map((route) => `${route.method} ${route.path}`);

  it("一覧に無いルートが登録されていない", () => {
    // **足したのに一覧へ書いていないと、ここで止まる。** 公開面が黙って
    // 広がらないようにするのがこのテストの役目である。
    expect(actual.filter((route) => !expected.includes(route))).toEqual([]);
  });

  it("一覧にあるルートがすべて登録されている", () => {
    // 消したのに一覧へ残っていると、ここで止まる。
    expect(expected.filter((route) => !actual.includes(route))).toEqual([]);
  });

  it("区分が重なっていない", () => {
    // **1 つのルートが 2 つの区分に載っていると、どちらの扱いか読めない。**
    const all = [...PUBLIC_ROUTES, ...SESSION_ROUTES, ...OAUTH_ROUTES].map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(all.length).toBe(new Set(all).size);
  });

  it("どの区分も空でない", () => {
    // **空の配列を `filter` しても `every` しても緑になる。** 0 件ガード。
    for (const [name, routes] of [
      ["PUBLIC_ROUTES", PUBLIC_ROUTES],
      ["SESSION_ROUTES", SESSION_ROUTES],
      ["OAUTH_ROUTES", OAUTH_ROUTES],
    ] as const) {
      expect(routes.length, `${name} が空`).toBeGreaterThan(0);
    }
  });
});
