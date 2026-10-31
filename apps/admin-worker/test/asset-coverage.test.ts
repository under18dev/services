import { collectAssetRefs, normalizeAssetHash } from "@u18/web-ui";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { ASSET_ROUTES, PROBE_PAGES } from "./route-inventory";
import { ORIGIN, executionContext } from "./helpers";

/**
 * アセット → ページの向き（#313、#447）。
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
 * #447 自体がこの両方の穴に落ちていた —— CSS の配信ルートが無くても、
 * どちらの検査も気づけなかった。`PROBE_PAGES`（`/callback`）が実際に
 * その CSS を参照していることを、手元のレンダリングで確かめる。
 *
 * ## `/callback` は 200 ではなく 400 を返す
 *
 * state も code も付けずに裸で叩くと `fail("missing_code_or_state")` が
 * `MessagePage`（Kiwa UI）を **400** で返す（`app.tsx`）。本文は返るので
 * 参照は読める——auth-worker / dashboard-worker の同名ファイルは 200 を
 * 期待しているが、ここだけ合わせて 400 にする。
 *
 * admin-worker は `EXTERNALLY_UNVERIFIABLE_ASSETS` を持たない
 * （アセットが CSS 1 本だけで、配っている Worker 自身の画面が
 * すべて外から読めるため）。
 */

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
      const response = await createApp().fetch(
        new Request(`${ORIGIN}${page}`),
        env,
        executionContext(),
      );
      // 400 でなければ参照が読めない。**0 件と区別が付かない**ので先に落とす。
      expect(response.status, `${page} が 400 を返さない`).toBe(400);
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
