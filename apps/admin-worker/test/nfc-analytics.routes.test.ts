import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { rpcOk } from "@u18/contracts";
import { createApp } from "../src/presentation/http/app";
import { ORIGIN, executionContext, fakeApprovals, loginAs, minimalNfcCards } from "./helpers";

/**
 * NFC の解析画面（`/nfc/analytics`、#454）。
 *
 * **業務ロジックはここでは確かめない。** nfc-worker 側の集計そのものは
 * `nfc-analytics-delegated.rpc.test.ts` / `card-analytics.repository.test.ts`
 * が持つ。ここで見るのは HTTP 層の責務——`days` のフォールバック、
 * `Promise.allSettled` で区画ごとに失敗を受け止めること、所有者を
 * 画面に出さないこと。
 */

const SUB = "usr_admin_analytics";

async function loginAsApproved(): Promise<string> {
  const approvals = fakeApprovals([SUB]);
  return loginAs(SUB, approvals);
}

/** 全区画が成功する既定の fake。個別のテストで上書きする。 */
function fullNfcCards() {
  return {
    ...minimalNfcCards(),
    tapTimeseries: async () =>
      rpcOk({
        dailyTotals: [{ date: "2026-11-04", total: 3 }],
        totalTaps: 3,
        dailyAverage: 0.1,
        maxDay: { date: "2026-11-04", total: 3 },
        retentionDays: 180,
      }),
    usageFunnel: async () =>
      rpcOk({ issued: 10, claimedEver: 5, tappedEver: 2, retentionDays: 180 }),
    batchAnalytics: async () =>
      rpcOk({
        rows: [
          {
            batch: "bunkasai-2026",
            issued: 6,
            claimedEver: 3,
            disabled: 1,
            tapsAllTime: 3,
            tapsLast7d: 1,
          },
          { batch: null, issued: 4, claimedEver: 2, disabled: 0, tapsAllTime: 0, tapsLast7d: 0 },
        ],
      }),
    cardUsageRanking: async () =>
      rpcOk({
        ranking: [
          { cardId: "nfc_popular", batch: "bunkasai-2026", status: "active", total: 5 },
        ] as const,
        dormant: {
          count: 1,
          rows: [
            {
              cardId: "nfc_dormant",
              batch: "bunkasai-2026",
              claimedAt: "2026-10-01T00:00:00.000Z",
              status: "active",
            },
          ] as const,
        },
      }),
    disabledReasonBreakdown: async () => rpcOk({ rows: [{ reason: "lost", count: 1 }] }),
    transferCountDistribution: async () => rpcOk({ zero: 8, one: 1, two: 1, threeOrMore: 0 }),
  };
}

describe("GET /nfc/analytics", () => {
  it("6 区画すべてを描く", async () => {
    const sessionCookie = await loginAsApproved();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: fullNfcCards() });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/analytics`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("タップの時系列");
    expect(html).toContain("ファネル");
    expect(html).toContain("バッチ別");
    expect(html).toContain("カード別ランキングと死蔵の検出");
    expect(html).toContain("無効化の内訳");
    expect(html).toContain("持ち主が変わり続けるカード");
  });

  /**
   * **`/nfc?batch=` へ辿り着く唯一の経路**（issue #481 への追記）。
   * バッチ名を持つ行はリンクに、「（バッチ名なし）」の行（`batch: null`）
   * はリンクにしない——`null` は「`なし` という名前のバッチ」ではない。
   */
  it("バッチ別の表で、バッチ名を /nfc?batch= へのリンクにする。バッチ名なしはリンクにしない", async () => {
    const sessionCookie = await loginAsApproved();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: fullNfcCards() });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/analytics`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain('href="/nfc?batch=bunkasai-2026"');
    // 「（バッチ名なし）」はテキストのまま——`<a>` の中に出てこない。
    expect(html).toContain("（バッチ名なし）");
    expect(html).not.toMatch(/<a[^>]*>\s*（バッチ名なし）\s*<\/a>/);
  });

  /**
   * **既知の理由コードは日本語で、知らない値はコードのまま**（#496）。
   * 「不明」とは書かない——値が無いのか、知らない値が入っているのかを
   * 運用者が区別できなくなるため（#471 の `UserRef` と同じ理由）。
   */
  it("既知の理由コードは日本語ラベルで、対応表に無い値は生のコードのまま出す。「不明」とは書かない", async () => {
    const sessionCookie = await loginAsApproved();
    const app = createApp({
      approvals: fakeApprovals([SUB]),
      nfcCards: {
        ...fullNfcCards(),
        disabledReasonBreakdown: async () =>
          rpcOk({
            rows: [
              { reason: "lost", count: 3 },
              { reason: "admin_batch", count: 1 },
              // ランブック §12.4(5) が今も使う運用値（コードは書かないが既知）。
              { reason: "ops", count: 1 },
              // 対応表に無い、実在が確認できていない値。
              { reason: "abuse", count: 1 },
              { reason: null, count: 2 },
            ],
          }),
      },
    });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/analytics`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("紛失のため");
    expect(html).toContain("（lost）");
    expect(html).toContain("運営の一括無効化");
    expect(html).toContain("（admin_batch）");
    expect(html).toContain("孤立カードへの運用対応");
    expect(html).toContain("（ops）");
    // 対応表に無い値は生のコードのまま——「不明」にしない。
    expect(html).toContain("<code");
    expect(html).toContain(">abuse</code>");
    expect(html).not.toContain("不明");
    expect(html).toContain("（なし）");
  });

  it("days 未指定は 30 を既定にし、見出し・ハイライトに使い回す", async () => {
    const sessionCookie = await loginAsApproved();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: fullNfcCards() });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/analytics`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("直近 30 日の日次合計");
    // ハイライトされた現在値は <a> ではなく <span> で出る。
    expect(html).toMatch(/<span[^>]*>30 日<\/span>/);
    expect(html).toContain('href="/nfc/analytics?days=90"');
    expect(html).toContain('href="/nfc/analytics?days=180"');
  });

  it("不正な days は 30 へ丸め、丸めた値を画面全体で使う（URL と画面をずらさない）", async () => {
    const sessionCookie = await loginAsApproved();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: fullNfcCards() });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/analytics?days=45`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("直近 30 日の日次合計");
    expect(html).toMatch(/<span[^>]*>30 日<\/span>/);
  });

  it("days=180 を選ぶとハイライトとリンクが入れ替わる", async () => {
    const sessionCookie = await loginAsApproved();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: fullNfcCards() });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/analytics?days=180`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("直近 180 日の日次合計");
    expect(html).toMatch(/<span[^>]*>180 日<\/span>/);
    expect(html).toContain('href="/nfc/analytics?days=30"');
  });

  it("1 区画が ok:false でも、他の区画は出す", async () => {
    const sessionCookie = await loginAsApproved();
    const app = createApp({
      approvals: fakeApprovals([SUB]),
      nfcCards: {
        ...fullNfcCards(),
        usageFunnel: async () => ({ ok: false, error: { code: "internal", message: "boom" } }),
      },
    });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/analytics`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("バッチ別");
    expect(html).toContain("いま取れません");
  });

  it("1 区画が reject しても、画面全体は潰れない（503 にしない）", async () => {
    // **これが Promise.all ではなく Promise.allSettled を使う理由。**
    // `app.tsx` の `/`（#449/#452）と同じ判断。
    const sessionCookie = await loginAsApproved();
    const app = createApp({
      approvals: fakeApprovals([SUB]),
      nfcCards: {
        ...fullNfcCards(),
        batchAnalytics: () => Promise.reject(new Error("binding unavailable")),
      },
    });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/analytics`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("タップの時系列");
    expect(html).toContain("いま取れません");
  });

  it("バッチ名の無いカードを「（バッチ名なし）」の行で出す", async () => {
    const sessionCookie = await loginAsApproved();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: fullNfcCards() });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/analytics`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("（バッチ名なし）");
  });

  it("ランキング・死蔵に所有者を出さない", async () => {
    const sessionCookie = await loginAsApproved();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: fullNfcCards() });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/analytics`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("nfc_popular");
    expect(html).toContain("nfc_dormant");
    expect(html).not.toContain("usr_");
    expect(html).not.toContain("ownerUserId");
  });
});

describe("未ログイン・未承認", () => {
  it("未ログインは /login へ送る", async () => {
    const app = createApp({ approvals: fakeApprovals([]) });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/analytics`),
      env,
      executionContext(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location") ?? "").toContain("/login?return_to=");
  });

  it("未承認は /pending へ送る", async () => {
    const approvals = fakeApprovals([]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/analytics`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/pending");
  });
});
