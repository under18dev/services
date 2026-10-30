import { env } from "cloudflare:test";
import { nfcCardEvents } from "@u18/nfc-db";
import { desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { NfcAdminDelegatedRPC } from "../src/presentation/rpc/nfc-admin-delegated.entrypoint";
import {
  db,
  executionContext,
  repository,
  resetDatabase,
  seedActiveCard,
  seedIssuedCard,
} from "./helpers";

/**
 * `NfcAdminDelegatedRPC`（#382 / #390 決定 16 ③）。
 *
 * ## ここで確かめること
 *
 * **これは nfc-worker が初めて公開する RPC である。** 他の Entrypoint
 * テスト（`oauth-client-admin.rpc.test.ts` など）と同じく、Entrypoint を
 * 直に `new` する —— Service Binding の配線は呼び出し元（admin-worker）
 * の責務で、ここで見たいのは**入力検証・UseCase への橋渡し・監査**。
 *
 *  1. `actorUserId` を**検証せず、そのまま監査へ記録する**こと
 *     （d5 の設計どおり。検証しないのが正しい振る舞いである）
 *  2. 入力の形が崩れていれば `invalid_input` で落ちる
 *  3. 存在しないカードは `not_found`
 *  4. 遷移先の URL 検証が効いている
 *  5. 無効化済みのカードへは両方のメソッドとも効かない
 */
const ACTOR = "usr_admin_from_admin_worker";

let rpc: NfcAdminDelegatedRPC;

beforeEach(async () => {
  await resetDatabase();
  rpc = new NfcAdminDelegatedRPC(executionContext(), env);
});

describe("disableCard", () => {
  it("他人のカードを無効化し、actorUserId をそのまま監査へ残す", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");

    const result = await rpc.disableCard({ actorUserId: ACTOR, cardId });

    expect(result.ok, "disableCard が失敗した").toBe(true);

    const card = await repository().findById(cardId);
    expect(card?.isDisabled).toBe(true);

    const rows = await db()
      .select()
      .from(nfcCardEvents)
      .where(eq(nfcCardEvents.cardId, cardId))
      .orderBy(desc(nfcCardEvents.id))
      .all();
    const disabledEvent = rows.find((row) => row.event === "card.disabled");

    // **ここが d5 の設計の核心。** actorUserId は検証されず、渡した
    // 値がそのまま監査へ入る。検証しないことそのものが仕様である。
    expect(disabledEvent?.actorUserId).toBe(ACTOR);
    expect(disabledEvent?.metadata?.["actingAsAdmin"]).toBe(true);
  });

  it("既に無効化済みのカードへもう一度叩いても失敗にしない（冪等）", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await rpc.disableCard({ actorUserId: ACTOR, cardId });

    const second = await rpc.disableCard({ actorUserId: ACTOR, cardId });

    expect(second.ok).toBe(true);
  });

  it("存在しないカードは not_found", async () => {
    const result = await rpc.disableCard({ actorUserId: ACTOR, cardId: "nfc_does_not_exist" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("入力の形が崩れていれば invalid_input で落ちる", async () => {
    const result = await rpc.disableCard({ actorUserId: "", cardId: "" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("invalid_input");
  });
});

describe("updateCardTarget", () => {
  it("他人のカードの遷移先を書き換え、actorUserId を監査へ残す", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/old");

    const result = await rpc.updateCardTarget({
      actorUserId: ACTOR,
      cardId,
      targetUrl: "https://example.com/new",
    });

    expect(result.ok, "updateCardTarget が失敗した").toBe(true);

    const card = await repository().findById(cardId);
    expect(card?.targetUrl).toBe("https://example.com/new");

    const rows = await db()
      .select()
      .from(nfcCardEvents)
      .where(eq(nfcCardEvents.cardId, cardId))
      .orderBy(desc(nfcCardEvents.id))
      .all();
    const updatedEvent = rows.find((row) => row.event === "card.target_updated");

    expect(updatedEvent?.actorUserId).toBe(ACTOR);
    expect(updatedEvent?.metadata?.["actingAsAdmin"]).toBe(true);
    // **前の値は残さない。** `UpdateCardTargetUseCase` と同じ判断。
    expect(JSON.stringify(updatedEvent?.metadata)).not.toContain("old");
  });

  it("不正な URL は invalid_input で、1 文字も書き換わらない", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/safe");

    const result = await rpc.updateCardTarget({
      actorUserId: ACTOR,
      cardId,
      targetUrl: "http://example.com/plain",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("invalid_input");

    const card = await repository().findById(cardId);
    expect(card?.targetUrl).toBe("https://example.com/safe");
  });

  it("無効化済みのカードへは効かない", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/original");
    await repository().disable(cardId, "usr_taro", "lost", new Date());

    const result = await rpc.updateCardTarget({
      actorUserId: ACTOR,
      cardId,
      targetUrl: "https://example.com/new",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("not_found");

    const card = await repository().findById(cardId);
    expect(card?.targetUrl).toBe("https://example.com/original");
  });

  it("未紐づけのカードへは効かない（active ではないので）", async () => {
    const cardId = await seedIssuedCard();

    const result = await rpc.updateCardTarget({
      actorUserId: ACTOR,
      cardId,
      targetUrl: "https://example.com/new",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("not_found");
  });
});

describe("listAllCards", () => {
  it("所有者を問わず全カードを返す", async () => {
    const mine = await seedActiveCard("usr_taro", "https://example.com/taro");
    const unclaimed = await seedIssuedCard("lot-a");

    const result = await rpc.listAllCards();

    expect(result.ok, "listAllCards が失敗した").toBe(true);
    if (!result.ok) return;

    const ids = result.value.cards.map((card) => card.cardId);
    expect(ids).toContain(mine);
    expect(ids).toContain(unclaimed);

    const minedCard = result.value.cards.find((card) => card.cardId === mine);
    expect(minedCard?.ownerUserId).toBe("usr_taro");
  });

  it("上限で打ち切ったことを返す（セッション版と同じ上限）", async () => {
    // **件数を埋めてまでは確かめない。** `MAX_ADMIN_LIST`（500）は
    // `ListAllCardsUseCase` と共有しているので、こちらで固定したいのは
    // 「0 枚のとき `truncated: false`」までで足りる —— 上限そのものの
    // 単体確認はセッション版のテストが持っている。
    const result = await rpc.listAllCards();

    expect(result.ok).toBe(true);
    expect(!result.ok ? undefined : result.value.truncated).toBe(false);
  });
});

describe("issueCards", () => {
  it("カードを発行し、actorUserId を監査へ残す", async () => {
    const result = await rpc.issueCards({ actorUserId: ACTOR, count: 3, batch: "lot-x" });

    expect(result.ok, "issueCards が失敗した").toBe(true);
    if (!result.ok) return;

    expect(result.value.cards).toHaveLength(3);

    const rows = await db()
      .select()
      .from(nfcCardEvents)
      .where(eq(nfcCardEvents.event, "card.issued"))
      .orderBy(desc(nfcCardEvents.id))
      .all();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]?.actorUserId).toBe(ACTOR);
    expect(rows[0]?.metadata?.["batch"]).toBe("lot-x");
  });

  it("枚数が範囲外なら invalid_input で、1 枚も作らない", async () => {
    const result = await rpc.issueCards({ actorUserId: ACTOR, count: 0, batch: null });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("invalid_input");

    const after = await rpc.listAllCards();
    expect(!after.ok ? undefined : after.value.cards).toHaveLength(0);
  });

  it("batch を指定しなければ null のまま発行される", async () => {
    const result = await rpc.issueCards({ actorUserId: ACTOR, count: 1, batch: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const card = await repository().findById(result.value.cards[0]!.cardId);
    expect(card?.batch).toBeNull();
  });
});
