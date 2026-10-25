import { nfcCardEvents } from "@u18/nfc-db";
import { createExecutionContext, createScheduledController, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { PurgeExpiredEventsUseCase } from "../src/application/use-cases/purge-expired-events.use-case";
import {
  NFC_CARD_EVENTS,
  NFC_EVENT_RETENTION,
  NfcRetention,
  nfcEventDeadlines,
  type NfcCardEventName,
} from "../src/domain/services/retention-policy";
import { DrizzleExpiredEventPurger } from "../src/infrastructure/persistence/drizzle-expired-event.purger";
import worker from "../src/index";
import { db, resetDatabase } from "./helpers";

/**
 * `nfc_card_events` の保持期限（仕様書 §9 Privacy）。
 *
 * **このテーブルには掃除する経路が 1 つも無かった。** `actor_user_id` を
 * 持つ行が無期限に残る状態で、保持期間を決めていないこと自体が
 * §9 Privacy の要求を満たしていなかった。
 */

const NOW = new Date("2026-10-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

beforeEach(resetDatabase);

const putEvent = (id: string, event: NfcCardEventName, createdAt: Date) =>
  db()
    .insert(nfcCardEvents)
    .values({ id, cardId: "nfc_x", event, actorUserId: "usr_taro", createdAt })
    .run();

const remaining = async (): Promise<string[]> =>
  (await db().select({ id: nfcCardEvents.id }).from(nfcCardEvents).all()).map((r) => r.id).sort();

const purge = (limit = 100) =>
  new DrizzleExpiredEventPurger(db()).purge(nfcEventDeadlines(NOW), limit);

describe("保持区分", () => {
  it("支配権が変わる操作は 180 日では消えない", async () => {
    // 1 年前。standard（180 日）なら消えるが ownership（2 年）なら残る。
    await putEvent("evt_claim", "card.claimed", ago(365 * DAY));
    await putEvent("evt_release", "card.released", ago(365 * DAY));

    expect(await purge()).toBe(0);
    expect(await remaining()).toEqual(["evt_claim", "evt_release"]);
  });

  it("それ以外は 180 日で消える", async () => {
    await putEvent("evt_target", "card.target_updated", ago(181 * DAY));
    await putEvent("evt_disabled", "card.disabled", ago(181 * DAY));

    expect(await purge()).toBe(2);
    expect(await remaining()).toEqual([]);
  });

  it("同じ日付でも区分で生死が分かれる", async () => {
    // **これが区分化の本体。** 1 本のクエリで両方を正しく扱えていないと
    // どちらかが巻き込まれる。
    const oneYearAgo = ago(365 * DAY);
    await putEvent("evt_keep", "card.claimed", oneYearAgo);
    await putEvent("evt_drop", "card.target_updated", oneYearAgo);

    expect(await purge()).toBe(1);
    expect(await remaining()).toEqual(["evt_keep"]);
  });

  it("2 年を過ぎれば支配権が変わる操作も消える", async () => {
    await putEvent("evt_old", "card.claimed", ago(731 * DAY));
    await putEvent("evt_young", "card.claimed", ago(729 * DAY));

    expect(await purge()).toBe(1);
    expect(await remaining()).toEqual(["evt_young"]);
  });

  it("保持期間の内側の行は消さない", async () => {
    await putEvent("evt_fresh", "card.target_updated", ago(1 * DAY));

    expect(await purge()).toBe(0);
    expect(await remaining()).toEqual(["evt_fresh"]);
  });

  it("知らないイベント名の行は消さない", async () => {
    // 境界を持たない名前を黙って消すより、残して気づくほうがよい。
    await db()
      .insert(nfcCardEvents)
      .values({
        id: "evt_unknown",
        cardId: "nfc_x",
        event: "card.something_new",
        actorUserId: null,
        createdAt: ago(1000 * DAY),
      })
      .run();

    expect(await purge()).toBe(0);
    expect(await remaining()).toEqual(["evt_unknown"]);
  });

  it("境界が空なら 1 行も消さない", async () => {
    // 全件消すほうへ倒さないこと。
    await putEvent("evt_old", "card.target_updated", ago(1000 * DAY));

    expect(await new DrizzleExpiredEventPurger(db()).purge(new Map(), 100)).toBe(0);
    expect(await remaining()).toEqual(["evt_old"]);
  });

  it("上限で打ち切る", async () => {
    for (let i = 0; i < 3; i++) await putEvent(`evt_${i}`, "card.target_updated", ago(200 * DAY));

    expect(await purge(2)).toBe(2);
    expect(await remaining()).toHaveLength(1);
  });
});

describe("登録簿と区分", () => {
  it("登録簿の全イベントに区分がある", () => {
    // `Record<NfcCardEventName, …>` なので型が守るが、キャストで
    // すり抜けた場合にここが最後の網になる。
    expect(Object.keys(NFC_EVENT_RETENTION).sort()).toEqual([...NFC_CARD_EVENTS].sort());
  });

  it("ownership は standard より長い", () => {
    // 逆転すると「長期側に置いたのに先に消える」になる。
    expect(NfcRetention.ownership).toBeGreaterThan(NfcRetention.standard);
  });

  it("支配権が変わる操作が長期側にある", () => {
    // 全部 standard に倒れたら区分化が効いていない。
    expect(NFC_EVENT_RETENTION["card.claimed"]).toBe("ownership");
    expect(NFC_EVENT_RETENTION["card.released"]).toBe("ownership");
  });

  it("src から発行されるイベント名が登録簿に揃っている", () => {
    // `CardEventRecorder.record()` の型が union なので、増やすと
    // ここと区分の両方を直さないとビルドが通らない。
    expect(NFC_CARD_EVENTS).toContain("card.claimed");
    expect(NFC_CARD_EVENTS.length).toBeGreaterThanOrEqual(4);
  });
});

describe("scheduled ハンドラ", () => {
  it("Cron 実行で保持期限を過ぎた行が消え、新しい行は残る", async () => {
    // **掃除の経路が繋がっていること自体の確認。** UseCase だけ直しても
    // Cron から呼ばれていなければ、本番では 1 行も消えない。
    const realNow = Date.now();
    await db()
      .insert(nfcCardEvents)
      .values([
        {
          id: "evt_stale",
          cardId: "nfc_x",
          event: "card.target_updated",
          actorUserId: "usr_taro",
          createdAt: new Date(realNow - 400 * DAY),
        },
        {
          id: "evt_fresh",
          cardId: "nfc_x",
          event: "card.target_updated",
          actorUserId: "usr_taro",
          createdAt: new Date(realNow),
        },
        {
          id: "evt_claim_old",
          cardId: "nfc_x",
          event: "card.claimed",
          actorUserId: "usr_taro",
          createdAt: new Date(realNow - 400 * DAY),
        },
      ])
      .run();

    const ctx = createExecutionContext();
    await worker.scheduled?.(createScheduledController({ cron: "17 * * * *" }), env, ctx);

    // 400 日前の target_updated だけが消える。claimed は 2 年残る。
    expect(await remaining()).toEqual(["evt_claim_old", "evt_fresh"]);
  });
});

describe("PurgeExpiredEventsUseCase", () => {
  it("掃除が失敗しても例外にしない", async () => {
    // Cron の実行が打ち切られると、何件消えたかの内訳が失われる。
    const useCase = new PurgeExpiredEventsUseCase({
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
