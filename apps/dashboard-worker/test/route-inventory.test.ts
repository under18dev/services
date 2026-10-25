import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { EXPECTED_ROUTES } from "./route-inventory";

/**
 * 登録されているルートが `route-inventory.ts` の一覧と一致すること。
 *
 * **これが落ちたら、まず一覧のほうを直す。** そのうえで
 * `client-type.test-d.ts` が落ちるなら、足したルートがチェーンに
 * 乗っていない（= `hono/client` から引けない）という意味である。
 * 意図の説明は `route-inventory.ts` を参照。
 */
describe("ルートの一覧", () => {
  // `ALL /*` はミドルウェア。ここで見たいのはエンドポイントだけ。
  const actual = createApp()
    .routes.filter((route) => route.method !== "ALL")
    .map((route) => `${route.method} ${route.path}`);

  const expected = EXPECTED_ROUTES.map((route) => `${route.method} ${route.path}`);

  it("一覧に無いルートが登録されていない", () => {
    // 足したのに一覧へ書いていないと、ここで止まる。
    expect(actual.filter((route) => !expected.includes(route))).toEqual([]);
  });

  it("一覧にあるルートがすべて登録されている", () => {
    // 消したのに一覧へ残っていると、ここで止まる。
    expect(expected.filter((route) => !actual.includes(route))).toEqual([]);
  });

  it("同じルートを 2 回登録していない", () => {
    // 2 回登録すると、先に書いたほうだけが動き、後のは黙って死ぬ。
    expect(actual).toEqual([...new Set(actual)]);
  });
});
