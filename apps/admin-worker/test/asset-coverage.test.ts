import { rpcOk } from "@u18/contracts";
import { collectAssetRefs, normalizeAssetHash } from "@u18/web-ui";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { ASSET_ROUTES, EXTERNALLY_UNVERIFIABLE_ASSETS, PROBE_PAGES } from "./route-inventory";
import {
  executionContext,
  fakeApprovals,
  loginAs,
  minimalIdentityAdmin,
  minimalNfcCards,
  ORIGIN,
} from "./helpers";

/**
 * アセット → ページの向き（#313、#447、#470）。
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
 * ## アイランドは `EXTERNALLY_UNVERIFIABLE_ASSETS` に宣言した（#470）
 *
 * CSS と違い、アイランドはログイン後の画面だけが読む。`PROBE_PAGES`
 * （未認証の `/callback`）からは見えないので、`dashboard-worker` と
 * 同じ形で「全画面（ログイン込み）を合わせれば覆える」ことを別に見る。
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

  it("外から確かめられないアセットには理由が書いてある", () => {
    for (const [asset, reason] of Object.entries(EXTERNALLY_UNVERIFIABLE_ASSETS)) {
      expect(EXPECTED_ASSETS, `${asset} は一覧に無い`).toContain(asset);
      // 空で通すと「確かめられない」が「確かめなくてよい」にすり替わる。
      expect(reason.trim().length, `${asset}: 理由が短すぎる`).toBeGreaterThan(20);
    }
  });

  it("PROBE_PAGES の参照だけで、宣言した範囲ちょうどを覆う", async () => {
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

    const declaredUnverifiable = Object.keys(EXTERNALLY_UNVERIFIABLE_ASSETS);
    const expectedVisible = EXPECTED_ASSETS.filter(
      (asset) => !declaredUnverifiable.includes(asset),
    );

    expect(
      [...seen].sort(),
      `PROBE_PAGES（${PROBE_PAGES.join(" ")}）を引いたときに見えるアセットが、` +
        `EXTERNALLY_UNVERIFIABLE_ASSETS の宣言と噛み合っていません。`,
    ).toEqual(expectedVisible);
  });
});

describe("ログイン後の画面を合わせると、アイランドまで覆える", () => {
  /**
   * アイランドを読む 3 画面（#470: `/audit` `/clients` `/nfc/analytics`）
   * だけを引く。**`/nfc` `/users` `/approvals` は引かない**
   * ——そちらにアイランドを足したのは別 issue（#471〜）で、ここで
   * 必要な fake を増やすと「このテストが見たいもの」がぼやける。
   */
  it("/audit /clients /nfc/analytics の参照が、宣言したアセットを全部覆う", async () => {
    const seen = new Set<string>();
    const sub = "usr_asset_coverage";
    const approvals = fakeApprovals([sub]);
    const overrides = {
      approvals,
      // `minimalNfcCards()` の `unused()` は**同期的に** throw する。
      // `/nfc/analytics` は `Promise.allSettled([container.nfcCards.
      // tapTimeseries(...), ...])` と**配列リテラルの中で直接呼ぶ**ので、
      // 同期 throw は allSettled に届く前に配列の組み立てごと落ちる
      // （本物の binding は常に Promise を返すので起きない、テスト専用の
      // 事情）。6 本とも空応答で解決する fake に差し替える。
      nfcCards: {
        ...minimalNfcCards(),
        tapTimeseries: async () =>
          rpcOk({
            dailyTotals: [],
            totalTaps: 0,
            dailyAverage: 0,
            maxDay: null,
            retentionDays: 180,
          }),
        usageFunnel: async () =>
          rpcOk({ issued: 0, claimedEver: 0, tappedEver: 0, retentionDays: 180 }),
        batchAnalytics: async () => rpcOk({ rows: [] }),
        cardUsageRanking: async () => rpcOk({ ranking: [], dormant: { count: 0, rows: [] } }),
        disabledReasonBreakdown: async () => rpcOk({ rows: [] }),
        transferCountDistribution: async () => rpcOk({ zero: 0, one: 0, two: 0, threeOrMore: 0 }),
      },
      // `/clients` は `listOAuthClients` を同期的に待つ（allSettled の外）
      // ので、`minimalIdentityAdmin()` の `unused()` のままだと 500 になる。
      identityAdmin: { ...minimalIdentityAdmin(), listOAuthClients: async () => rpcOk([]) },
    };
    const cookie = await loginAs(sub, approvals, overrides);

    for (const path of ["/audit", "/clients", "/nfc/analytics"]) {
      const response = await createApp(overrides).fetch(
        new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } }),
        env,
        executionContext(),
      );
      expect(response.status, `${path} が 200 を返さない`).toBe(200);
      for (const ref of collectAssetRefs(await response.text())) seen.add(ref);
    }

    expect([...seen].sort()).toEqual(expect.arrayContaining(EXPECTED_ASSETS));
  });
});
