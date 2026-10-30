import { nfcCardTaps } from "@u18/nfc-db";
import { createExecutionContext, createScheduledController, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { PurgeExpiredTapsUseCase } from "../src/application/use-cases/purge-expired-taps.use-case";
import { isoDateUtc, tapCountDeadline } from "../src/domain/services/retention-policy";
import { DrizzleExpiredTapPurger } from "../src/infrastructure/persistence/drizzle-expired-tap.purger";
import worker from "../src/index";
import { db, resetDatabase } from "./helpers";

/**
 * `nfc_card_taps` の保持期限（#394）。`standard`（180 日）をそのまま使う。
 * `event-retention.test.ts`（`nfc_card_events` 側）と同じ道具立て。
 */

const NOW = new Date("2026-10-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const dateAgo = (ms: number) => isoDateUtc(new Date(NOW.getTime() - ms));

beforeEach(resetDatabase);

const putTap = (cardId: string, date: string, count = 1) =>
  db().insert(nfcCardTaps).values({ cardId, date, count }).run();

const remaining = async (): Promise<string[]> =>
  (
    await db()
      .select({ cardId: nfcCardTaps.cardId, date: nfcCardTaps.date })
      .from(nfcCardTaps)
      .all()
  )
    .map((r) => `${r.cardId}:${r.date}`)
    .sort();

const purge = (limit = 100) =>
  new DrizzleExpiredTapPurger(db()).purge(tapCountDeadline(NOW), limit);

describe("保持期限", () => {
  it("180 日より古い行は消える", async () => {
    await putTap("nfc_a", dateAgo(181 * DAY));

    expect(await purge()).toBe(1);
    expect(await remaining()).toEqual([]);
  });

  it("180 日の内側は消さない", async () => {
    await putTap("nfc_a", dateAgo(1 * DAY));

    expect(await purge()).toBe(0);
    expect(await remaining()).toEqual(["nfc_a:" + dateAgo(1 * DAY)]);
  });

  it("古い行と新しい行が混ざっていたら古いほうだけ消す", async () => {
    await putTap("nfc_old", dateAgo(200 * DAY));
    await putTap("nfc_new", dateAgo(1 * DAY));

    expect(await purge()).toBe(1);
    expect(await remaining()).toEqual(["nfc_new:" + dateAgo(1 * DAY)]);
  });

  it("上限で打ち切る", async () => {
    await putTap("nfc_a", dateAgo(200 * DAY));
    await putTap("nfc_b", dateAgo(200 * DAY));
    await putTap("nfc_c", dateAgo(200 * DAY));

    expect(await purge(2)).toBe(2);
    expect(await remaining()).toHaveLength(1);
  });

  it("同じカードの別の日の行は、片方だけ消える", async () => {
    // 複合主キー（card_id, date）が効いていることの確認。
    // card_id だけで消すと、同じカードの新しい行まで巻き込む。
    await putTap("nfc_a", dateAgo(200 * DAY));
    await putTap("nfc_a", dateAgo(1 * DAY));

    expect(await purge()).toBe(1);
    expect(await remaining()).toEqual(["nfc_a:" + dateAgo(1 * DAY)]);
  });
});

describe("境界の計算", () => {
  it("UTC の日付文字列になる", () => {
    expect(tapCountDeadline(NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("ちょうど 180 日前の 0 時になる", () => {
    const deadline = tapCountDeadline(NOW);
    const expected = isoDateUtc(new Date(NOW.getTime() - 180 * DAY));
    expect(deadline).toBe(expected);
  });
});

describe("scheduled ハンドラ", () => {
  it("Cron 実行で保持期限を過ぎたタップ集計が消え、新しいものは残る", async () => {
    const realNow = Date.now();
    await db()
      .insert(nfcCardTaps)
      .values([
        { cardId: "nfc_stale", date: isoDateUtc(new Date(realNow - 400 * DAY)), count: 5 },
        { cardId: "nfc_fresh", date: isoDateUtc(new Date(realNow)), count: 2 },
      ])
      .run();

    const ctx = createExecutionContext();
    await worker.scheduled?.(createScheduledController({ cron: "17 * * * *" }), env, ctx);

    const rows = await db().select({ cardId: nfcCardTaps.cardId }).from(nfcCardTaps).all();
    expect(rows.map((r) => r.cardId)).toEqual(["nfc_fresh"]);
  });
});

describe("PurgeExpiredTapsUseCase", () => {
  it("掃除が失敗しても例外にしない", async () => {
    const useCase = new PurgeExpiredTapsUseCase({
      purger: {
        purge: () => {
          throw new Error("D1_ERROR");
        },
      },
      clock: { now: () => NOW },
    });

    await expect(useCase.execute()).resolves.toMatchObject({ deleted: 0 });
  });
});
