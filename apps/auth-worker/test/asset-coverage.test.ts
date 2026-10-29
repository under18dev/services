import { collectAssetRefs, normalizeAssetHash } from "@u18/web-ui";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ASSET_ROUTES, PROBE_PAGES } from "./route-inventory";

/**
 * アセット → ページの向き（#313）。
 *
 * ## すでにある検査では足りない
 *
 * - `route-inventory.test.ts` は**登録されているか**を見る。アセットの
 *   ルートが実在することは分かるが、**どこかのページがそれを参照して
 *   いるか**は見ていない
 * - `scripts/smoke-asset-probe.sh` は**ページ → アセット**の向き。
 *   ページに書いてある URL を本番で引くので、**ページが参照しなくなった
 *   アセットは、はじめから視界に入らない**
 *
 * dashboard-worker で実際に起きた —— #316 で画面を割ったとき、本番検査が
 * 引いていた `/account` がアイランドを読まなくなり、**検査は緑のまま
 * 対象だけが減った。** こちらでも同じことが起こりうる。
 */

const BASE = "http://localhost";

const EXPECTED_ASSETS = ASSET_ROUTES.map((route) => normalizeAssetHash(route.path)).sort();

describe("本番検査が引くページで、アセットを全部覆える", () => {
  it("一覧にアセットがある", () => {
    // 0 件だと下のテストが**何も確かめずに通る。**
    expect(EXPECTED_ASSETS.length).toBeGreaterThan(0);
  });

  it("PROBE_PAGES が空でない", () => {
    expect(PROBE_PAGES.length).toBeGreaterThan(0);
  });

  it("PROBE_PAGES の参照だけで一覧のアセットを全部覆う", async () => {
    const seen = new Set<string>();
    for (const page of PROBE_PAGES) {
      const response = await SELF.fetch(`${BASE}${page}`);
      // 200 でなければ参照が読めない。**0 件と区別が付かない**ので先に落とす。
      expect(response.status, `${page} が 200 を返さない`).toBe(200);
      for (const ref of collectAssetRefs(await response.text())) seen.add(ref);
    }

    const uncovered = EXPECTED_ASSETS.filter((asset) => !seen.has(asset));
    expect(
      uncovered,
      `PROBE_PAGES（${PROBE_PAGES.join(" ")}）がこのアセットを参照していません。` +
        `本番検査の視界から外れます。`,
    ).toEqual([]);
  });
});
