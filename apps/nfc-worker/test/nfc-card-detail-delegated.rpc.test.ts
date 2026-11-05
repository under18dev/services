import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { NfcAdminDelegatedRPC } from "../src/presentation/rpc/nfc-admin-delegated.entrypoint";
import {
  executionContext,
  resetDatabase,
  seedActiveCard,
  seedIssuedCard,
  tapRecorder,
} from "./helpers";

/**
 * `NfcAdminDelegatedRPC` のカード 1 枚の詳細・タップ履歴（#472）。
 *
 * **業務ロジックの細部は Repository レベルのテストが持つ**
 * （`card.repository.test.ts` / `card-tap.recorder.test.ts`）。ここで見るのは
 * 入力検証・UseCase への橋渡し・応答の形——`nfc-analytics-delegated.rpc.test.ts`
 * と同じ役割分担。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `now - n` 日の UTC 日付文字列。use case 側（`isoDateUtc`）と同じ計算方法で揃える。 */
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * MS_PER_DAY).toISOString().slice(0, 10);
}

let rpc: NfcAdminDelegatedRPC;

beforeEach(async () => {
  await resetDatabase();
  rpc = new NfcAdminDelegatedRPC(executionContext(), env);
});

describe("getCard", () => {
  it("存在しないカードは not_found", async () => {
    const result = await rpc.getCard({ actorUserId: "usr_admin", cardId: "nfc_nope" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("発行直後のカードは、タップ無しの形で返る", async () => {
    const cardId = await seedIssuedCard("bunkasai-2026");

    const result = await rpc.getCard({ actorUserId: "usr_admin", cardId });

    expect(result.ok, "getCard が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      cardId,
      status: "issued",
      ownerUserId: null,
      batch: "bunkasai-2026",
      claimedAt: null,
      transferCount: 0,
      disabledAt: null,
      disabledReason: null,
      tapCount: 0,
      lastTappedAt: null,
    });
  });

  it("タップ済みなら合計と最終タップ日を返す", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await tapRecorder().recordTap(cardId, isoDaysAgo(5));
    await tapRecorder().recordTap(cardId, isoDaysAgo(1));

    const result = await rpc.getCard({ actorUserId: "usr_admin", cardId });

    expect(result.ok, "getCard が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value.tapCount).toBe(2);
    expect(result.value.lastTappedAt).toBe(isoDaysAgo(1));
  });

  it("無効化されたカードは理由と日時を返す", async () => {
    const cardId = await seedActiveCard("usr_taro");
    const disabled = await rpc.disableCard({ actorUserId: "usr_admin", cardId });
    expect(disabled.ok).toBe(true);

    const result = await rpc.getCard({ actorUserId: "usr_admin", cardId });

    expect(result.ok, "getCard が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("disabled");
    expect(result.value.disabledReason).toBe("admin_action");
    expect(result.value.disabledAt).not.toBeNull();
  });
});

describe("cardTapHistory", () => {
  it("30 / 90 / 180 以外は invalid_input", async () => {
    const cardId = await seedIssuedCard();

    // @ts-expect-error 不正な days を渡す
    const result = await rpc.cardTapHistory({ actorUserId: "usr_admin", cardId, days: 45 });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("invalid_input");
  });

  it("存在しないカードは not_found", async () => {
    const result = await rpc.cardTapHistory({
      actorUserId: "usr_admin",
      cardId: "nfc_nope",
      days: 30,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("引き取り済みでタップ 0 件なら、全部ゼロ・null で返る（死蔵の形）", async () => {
    const cardId = await seedActiveCard("usr_taro");

    const result = await rpc.cardTapHistory({ actorUserId: "usr_admin", cardId, days: 30 });

    expect(result.ok, "cardTapHistory が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value.dailyTotals).toHaveLength(30);
    expect(result.value.totalTaps).toBe(0);
    expect(result.value.lastTappedAt).toBeNull();
    expect(result.value.daysSinceLastTap).toBeNull();
    expect(result.value.last7d).toEqual({ total: 0, previousTotal: 0 });
    expect(result.value.last30d).toEqual({ total: 0, previousTotal: 0 });
  });

  it("days 日ぶんの密な配列と、保持期間の日数を返す", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await tapRecorder().recordTap(cardId, isoDaysAgo(0));

    const result = await rpc.cardTapHistory({ actorUserId: "usr_admin", cardId, days: 30 });

    expect(result.ok, "cardTapHistory が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value.dailyTotals).toHaveLength(30);
    expect(result.value.totalTaps).toBe(1);
    expect(result.value.retentionDays).toBe(180);
    expect(result.value.lastTappedAt).toBe(isoDaysAgo(0));
    expect(result.value.daysSinceLastTap).toBe(0);
  });

  it("直近 7 日・30 日と、その直前の同じ長さの期間を別々に数える", async () => {
    const cardId = await seedActiveCard("usr_taro");
    // 直近 7 日に 2 回。
    await tapRecorder().recordTap(cardId, isoDaysAgo(1));
    await tapRecorder().recordTap(cardId, isoDaysAgo(6));
    // その直前 7 日（8〜13 日前）に 1 回——直近 30 日の合計にも乗る。
    await tapRecorder().recordTap(cardId, isoDaysAgo(10));
    // 30〜59 日前（直前 30 日）に 1 回。
    await tapRecorder().recordTap(cardId, isoDaysAgo(40));

    const result = await rpc.cardTapHistory({ actorUserId: "usr_admin", cardId, days: 30 });

    expect(result.ok, "cardTapHistory が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value.last7d).toEqual({ total: 2, previousTotal: 1 });
    expect(result.value.last30d).toEqual({ total: 3, previousTotal: 1 });
    // 30 日の表示ウィンドウには 40 日前のタップは含まれない。
    expect(result.value.totalTaps).toBe(3);
  });

  it("タップの生ログに当たるフィールドを持たない", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await tapRecorder().recordTap(cardId, isoDaysAgo(0));

    const result = await rpc.cardTapHistory({ actorUserId: "usr_admin", cardId, days: 30 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("hourly");
    expect(result.value).not.toHaveProperty("events");
  });
});
