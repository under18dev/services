import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase, seedIssuedCard, tapRecorder } from "./helpers";

/**
 * `DrizzleCardTapRecorder` の新しい集計メソッド（#454「解析」）。
 *
 * 書き込み（`recordTap`）と単純な `totalsFor` は既存の経路
 * （`nfc-admin-delegated.rpc.test.ts` の `listAllCards`）がすでに通して
 * いるので、ここでは新しい 2 本だけを確かめる。
 */

beforeEach(resetDatabase);

describe("dailyTotals", () => {
  it("境界日以降の日ごとの合計を返す。境界より前は含まない", async () => {
    const cardId = await seedIssuedCard();
    await tapRecorder().recordTap(cardId, "2026-10-28");
    await tapRecorder().recordTap(cardId, "2026-10-29");
    await tapRecorder().recordTap(cardId, "2026-10-29");
    await tapRecorder().recordTap(cardId, "2026-10-27"); // 境界より前

    const rows = await tapRecorder().dailyTotals("2026-10-28");

    expect(rows).toEqual(
      expect.arrayContaining([
        { date: "2026-10-28", total: 1 },
        { date: "2026-10-29", total: 2 },
      ]),
    );
    expect(rows.find((row) => row.date === "2026-10-27")).toBeUndefined();
  });

  it("複数カードの同じ日は合算する", async () => {
    const cardA = await seedIssuedCard();
    const cardB = await seedIssuedCard();
    await tapRecorder().recordTap(cardA, "2026-10-30");
    await tapRecorder().recordTap(cardB, "2026-10-30");

    const rows = await tapRecorder().dailyTotals("2026-10-30");

    expect(rows).toEqual([{ date: "2026-10-30", total: 2 }]);
  });

  it("タップが無ければ空配列（0 件の日を埋めるのは呼び出し側の仕事）", async () => {
    expect(await tapRecorder().dailyTotals("2026-10-01")).toEqual([]);
  });
});

describe("countDistinctWithTaps", () => {
  it("1 回以上タップされたカードの枚数を数える。重複は 1 枚として数える", async () => {
    const cardA = await seedIssuedCard();
    const cardB = await seedIssuedCard();
    await seedIssuedCard(); // 1 度もタップされていないカード
    await tapRecorder().recordTap(cardA, "2026-10-30");
    await tapRecorder().recordTap(cardA, "2026-10-31");
    await tapRecorder().recordTap(cardB, "2026-10-30");

    expect(await tapRecorder().countDistinctWithTaps()).toBe(2);
  });

  it("タップが無ければ 0", async () => {
    expect(await tapRecorder().countDistinctWithTaps()).toBe(0);
  });
});
