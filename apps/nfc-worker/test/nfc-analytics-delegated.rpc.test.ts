import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { NfcAdminDelegatedRPC } from "../src/presentation/rpc/nfc-admin-delegated.entrypoint";
import {
  executionContext,
  resetDatabase,
  seedActiveCard,
  seedIssuedCard,
  tapRecorder,
} from "./helpers";

/**
 * `NfcAdminDelegatedRPC` の解析系メソッド（#454）。
 *
 * **業務ロジックの細部は Repository レベルのテストが持つ**
 * （`card-analytics.repository.test.ts` / `card.repository.test.ts` /
 * `card-tap.recorder.test.ts`）。ここで見るのは、入力検証・UseCase への
 * 橋渡し・応答の形——`nfc-admin-delegated.rpc.test.ts` と同じ役割分担。
 */

let rpc: NfcAdminDelegatedRPC;

beforeEach(async () => {
  await resetDatabase();
  rpc = new NfcAdminDelegatedRPC(executionContext(), env);
});

describe("tapTimeseries", () => {
  it("30 / 90 / 180 以外は invalid_input", async () => {
    // @ts-expect-error 不正な days を渡す
    const result = await rpc.tapTimeseries({ days: 45 });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("invalid_input");
  });

  it("days 日ぶんの密な配列と、保持期間の日数を返す", async () => {
    const cardId = await seedIssuedCard();
    const today = new Date().toISOString().slice(0, 10);
    await tapRecorder().recordTap(cardId, today);

    const result = await rpc.tapTimeseries({ days: 30 });

    expect(result.ok, "tapTimeseries が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value.dailyTotals).toHaveLength(30);
    expect(result.value.totalTaps).toBe(1);
    expect(result.value.retentionDays).toBe(180);
  });
});

describe("usageFunnel", () => {
  it("発行・引き取り・使用の 3 段を返す", async () => {
    await seedIssuedCard();
    const claimed = await seedActiveCard("usr_taro");
    await tapRecorder().recordTap(claimed, "2026-10-01");

    const result = await rpc.usageFunnel();

    expect(result.ok, "usageFunnel が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value.issued).toBe(2);
    expect(result.value.claimedEver).toBe(1);
    expect(result.value.tappedEver).toBe(1);
    expect(result.value.retentionDays).toBe(180);
  });
});

describe("batchAnalytics", () => {
  it("バッチごとの行を返す。バッチ名の無いカードも含む", async () => {
    await seedIssuedCard("bunkasai-2026");
    await seedIssuedCard(null);

    const result = await rpc.batchAnalytics();

    expect(result.ok, "batchAnalytics が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((row) => row.batch)).toEqual(
      expect.arrayContaining(["bunkasai-2026", null]),
    );
  });
});

describe("cardUsageRanking", () => {
  it("limit が範囲外なら invalid_input", async () => {
    const result = await rpc.cardUsageRanking({ limit: 0 });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("invalid_input");
  });

  it("ランキングと死蔵の両方を返し、所有者を含まない", async () => {
    const popular = await seedIssuedCard();
    await tapRecorder().recordTap(popular, "2026-10-01");
    await seedActiveCard("usr_taro"); // 死蔵候補

    const result = await rpc.cardUsageRanking({ limit: 20 });

    expect(result.ok, "cardUsageRanking が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value.ranking[0]?.cardId).toBe(popular);
    expect(result.value.ranking[0]).not.toHaveProperty("ownerUserId");
    expect(result.value.dormant.count).toBe(1);
    expect(result.value.dormant.rows[0]).not.toHaveProperty("ownerUserId");
  });
});

describe("disabledReasonBreakdown", () => {
  it("disabled_reason 別の内訳を返す", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await rpc.disableCard({ actorUserId: "usr_admin", cardId });

    const result = await rpc.disabledReasonBreakdown();

    expect(result.ok, "disabledReasonBreakdown が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toEqual([{ reason: "admin_action", count: 1 }]);
  });
});

describe("transferCountDistribution", () => {
  it("transferCount の分布を返す", async () => {
    await seedIssuedCard();

    const result = await rpc.transferCountDistribution();

    expect(result.ok, "transferCountDistribution が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ zero: 1, one: 0, two: 0, threeOrMore: 0 });
  });
});
