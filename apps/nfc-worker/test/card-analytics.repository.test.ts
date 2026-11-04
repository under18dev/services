import { beforeEach, describe, expect, it } from "vitest";
import { DrizzleCardAnalyticsRepository } from "../src/infrastructure/persistence/drizzle-card-analytics.repository";
import {
  db,
  repository,
  resetDatabase,
  seedActiveCard,
  seedIssuedCard,
  tapRecorder,
} from "./helpers";

/**
 * `DrizzleCardAnalyticsRepository`（#454「解析」）。
 *
 * **ここだけが `nfc_cards` と `nfc_card_taps` を JOIN する**——設計意図は
 * `CardAnalyticsRepository`（`application/ports.ts`）の冒頭を参照。
 */

const analytics = () => new DrizzleCardAnalyticsRepository(db());

beforeEach(resetDatabase);

describe("batchAnalytics", () => {
  it("バッチごとに発行・引き取り・無効化・タップ合計を集計する", async () => {
    const now = new Date();
    // issued のまま: 2 枚
    const issuedOnlyA = await seedIssuedCard("bunkasai-2026");
    await seedIssuedCard("bunkasai-2026");
    // 引き取り済み（active）: 1 枚
    const claimed = await seedIssuedCard("bunkasai-2026");
    await repository().claim(claimed, "usr_taro", now);
    // 引き取ったあと無効化: 1 枚（claimedEver と disabled の両方に数える）
    const claimedThenDisabled = await seedIssuedCard("bunkasai-2026");
    await repository().claim(claimedThenDisabled, "usr_hanako", now);
    await repository().disable(claimedThenDisabled, "usr_hanako", "lost", now);

    await tapRecorder().recordTap(issuedOnlyA, "2026-10-01");
    await tapRecorder().recordTap(issuedOnlyA, "2026-10-01");

    const rows = await analytics().batchAnalytics("2026-01-01");
    const bunkasai = rows.find((row) => row.batch === "bunkasai-2026");

    // sevenDaysAgo に遠い過去を渡しているので、タップは両方とも
    // 「直近 7 日」の境界内に入る（境界そのものは次のテストで確かめる）。
    expect(bunkasai).toEqual({
      batch: "bunkasai-2026",
      issued: 4,
      claimedEver: 2,
      disabled: 1,
      tapsAllTime: 2,
      tapsLast7d: 2,
    });
  });

  it("バッチ名が無いカード（null）も 1 行として出す——落とすと合計が合わなくなる", async () => {
    await seedIssuedCard(null);
    await seedIssuedCard(null);

    const rows = await analytics().batchAnalytics("2026-01-01");
    const noBatch = rows.find((row) => row.batch === null);

    expect(noBatch?.issued).toBe(2);
    // 合計が発行総数と一致することを確かめる。
    expect(rows.reduce((sum, row) => sum + row.issued, 0)).toBe(await repository().countTotal());
  });

  it("直近 7 日のタップは境界で絞る", async () => {
    const cardId = await seedIssuedCard("recent-batch");
    await tapRecorder().recordTap(cardId, "2026-10-30"); // 境界内
    await tapRecorder().recordTap(cardId, "2026-10-20"); // 境界外

    const rows = await analytics().batchAnalytics("2026-10-28");
    const row = rows.find((r) => r.batch === "recent-batch");

    expect(row?.tapsAllTime).toBe(2);
    expect(row?.tapsLast7d).toBe(1);
  });

  it("タップが 1 件も無いバッチは 0 として出る（JOIN で消えない）", async () => {
    await seedIssuedCard("no-taps-batch");

    const rows = await analytics().batchAnalytics("2026-01-01");
    const row = rows.find((r) => r.batch === "no-taps-batch");

    expect(row?.tapsAllTime).toBe(0);
    expect(row?.tapsLast7d).toBe(0);
  });
});

describe("rankedTaps", () => {
  it("タップ合計の多い順に、所有者を含めずに返す", async () => {
    const popular = await seedIssuedCard("bunkasai-2026");
    const quiet = await seedIssuedCard("bunkasai-2026");
    await tapRecorder().recordTap(popular, "2026-10-01");
    await tapRecorder().recordTap(popular, "2026-10-02");
    await tapRecorder().recordTap(quiet, "2026-10-01");

    const ranking = await analytics().rankedTaps(10);

    expect(ranking[0]).toEqual({
      cardId: popular,
      batch: "bunkasai-2026",
      status: "issued",
      total: 2,
    });
    expect(ranking[1]?.cardId).toBe(quiet);
    // 所有者フィールドを持たないこと（型レベルでも持たないが、値としても確認）。
    expect(ranking[0]).not.toHaveProperty("ownerUserId");
  });

  it("limit を超えない", async () => {
    for (let i = 0; i < 5; i++) {
      const cardId = await seedIssuedCard();
      await tapRecorder().recordTap(cardId, "2026-10-01");
    }

    expect(await analytics().rankedTaps(3)).toHaveLength(3);
  });

  it("タップが無ければ空配列", async () => {
    await seedIssuedCard();
    expect(await analytics().rankedTaps(10)).toEqual([]);
  });
});

describe("dormantClaimedCards", () => {
  it("引き取り済みでタップ0件のカードだけを数え、claimedAt昇順で返す", async () => {
    const dormantOld = await seedActiveCard("usr_taro");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const dormantNew = await seedActiveCard("usr_hanako");
    const used = await seedActiveCard("usr_jiro");
    await tapRecorder().recordTap(used, "2026-10-01");
    await seedIssuedCard(); // 引き取られていないので対象外

    const result = await analytics().dormantClaimedCards(10);

    expect(result.count).toBe(2);
    expect(result.rows.map((row) => row.cardId)).toEqual([dormantOld, dormantNew]);
    expect(result.rows[0]).not.toHaveProperty("ownerUserId");
  });

  it("count は正確で、rows は limit で切れる", async () => {
    for (let i = 0; i < 5; i++) {
      await seedActiveCard(`usr_${i}`);
    }

    const result = await analytics().dormantClaimedCards(2);

    expect(result.count).toBe(5);
    expect(result.rows).toHaveLength(2);
  });

  it("タップがあれば死蔵から外れる", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await tapRecorder().recordTap(cardId, "2026-10-01");

    expect((await analytics().dormantClaimedCards(10)).count).toBe(0);
  });

  it("引き取られていないカードは対象外", async () => {
    await seedIssuedCard();
    expect((await analytics().dormantClaimedCards(10)).count).toBe(0);
  });
});
