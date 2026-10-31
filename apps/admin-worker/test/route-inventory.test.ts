import { normalizeAssetHash } from "@u18/web-ui";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { EXPECTED_ROUTES } from "./route-inventory";

/**
 * 登録されているルートが `route-inventory.ts` の一覧と一致すること
 * （dashboard-worker の `route-inventory.test.ts` と同じ形）。
 *
 * これが落ちたら、まず一覧のほうを直す。`check-app-catalog-routes.mjs` が
 * `ADMIN_NAV_GROUPS` の href をこの一覧へ突き合わせているので、ここが
 * 実物とずれていると、あちらは実際には 404 するリンクを緑で通す。
 */
describe("ルートの一覧", () => {
  const actual = [
    ...new Set(
      createApp()
        .routes.filter((route) => route.method !== "ALL")
        .map((route) => `${route.method} ${normalizeAssetHash(route.path)}`),
    ),
  ];

  const expected = EXPECTED_ROUTES.map((route) => `${route.method} ${route.path}`);

  it("一覧に無いルートが登録されていない", () => {
    expect(actual.filter((route) => !expected.includes(route))).toEqual([]);
  });

  it("一覧にあるルートがすべて登録されている", () => {
    expect(expected.filter((route) => !actual.includes(route))).toEqual([]);
  });
});
