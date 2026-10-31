import { env } from "cloudflare:test";
import { newCardId } from "@u18/domain";
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

/**
 * `seedActiveCard` は `batch` を受け取らない（既定 "test-batch" 固定）ので、
 * 「同じバッチ名の active カードは対象外」を確かめるために、ここだけ
 * issue → claim → updateTarget を直接呼ぶ。
 */
async function seedActiveCardWithBatch(ownerUserId: string, batch: string): Promise<string> {
  const cardId = newCardId();
  const now = new Date();
  await repository().issue({ id: cardId, batch }, now);
  await repository().claim(cardId, ownerUserId, now);
  await repository().updateTarget(cardId, ownerUserId, "https://example.com/taro", now);
  return cardId;
}

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

  /**
   * **#427 から。** それ以前は `active` だけが対象で、`issued`
   * （未紐づけ）のカードを無効化する経路が 1 つも無かった——単発でも
   * 使えないと、一括（`batchDisableCards`）だけが「issued を無効化する」
   * 能力を持つ、安全な単発版の無い危ない形になる。
   */
  it("issued（未紐づけ）のカードも無効化できる", async () => {
    const cardId = await seedIssuedCard();

    const result = await rpc.disableCard({ actorUserId: ACTOR, cardId });

    expect(result.ok, "disableCard が失敗した").toBe(true);
    const card = await repository().findById(cardId);
    expect(card?.isDisabled).toBe(true);
  });
});

describe("releaseCard", () => {
  it("他人のカードを手放させ、issued へ戻し、遷移先を消す", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");

    const result = await rpc.releaseCard({ actorUserId: ACTOR, cardId });

    expect(result.ok, "releaseCard が失敗した").toBe(true);

    const card = await repository().findById(cardId);
    expect(card?.status).toBe("issued");
    expect(card?.ownerUserId).toBeNull();
    expect(card?.targetUrl).toBeNull();
  });

  it("付け替えない。直接別の利用者には束縛しない", async () => {
    // **これが #422 の核心である。** 入力に宛先の userId を受け取る
    // フィールドが無いことそのものが、直接付け替えない設計の表明。
    const cardId = await seedActiveCard("usr_taro");

    await rpc.releaseCard({ actorUserId: ACTOR, cardId });

    const card = await repository().findById(cardId);
    expect(card?.ownerUserId).toBeNull();
  });

  it("actorUserId をそのまま監査へ残し、本人の release とは metadata で区別する", async () => {
    const cardId = await seedActiveCard("usr_taro");

    await rpc.releaseCard({ actorUserId: ACTOR, cardId });

    const rows = await db()
      .select()
      .from(nfcCardEvents)
      .where(eq(nfcCardEvents.cardId, cardId))
      .orderBy(desc(nfcCardEvents.id))
      .all();
    const releasedEvent = rows.find((row) => row.event === "card.released");

    // **イベント名は増やさない。** `AdminDisableCardUseCase` と同じ判断——
    // 本人の release と同じ `card.released` を使い回し、`actingAsAdmin`
    // で区別する。
    expect(releasedEvent?.actorUserId).toBe(ACTOR);
    expect(releasedEvent?.metadata?.["actingAsAdmin"]).toBe(true);
  });

  it("既に issued のカードへもう一度叩いても失敗にしない（冪等）", async () => {
    const cardId = await seedIssuedCard();

    const result = await rpc.releaseCard({ actorUserId: ACTOR, cardId });

    expect(result.ok).toBe(true);
  });

  it("無効化済みのカードは手放せない", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await rpc.disableCard({ actorUserId: ACTOR, cardId });

    const result = await rpc.releaseCard({ actorUserId: ACTOR, cardId });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("存在しないカードは not_found", async () => {
    const result = await rpc.releaseCard({ actorUserId: ACTOR, cardId: "nfc_does_not_exist" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("入力の形が崩れていれば invalid_input で落ちる", async () => {
    const result = await rpc.releaseCard({ actorUserId: "", cardId: "" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("invalid_input");
  });
});

describe("reinstateCard", () => {
  it("無効化されたカードを active へ戻し、所有者・遷移先はそのまま残す", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");
    await rpc.disableCard({ actorUserId: ACTOR, cardId });

    const result = await rpc.reinstateCard({ actorUserId: ACTOR, cardId });

    expect(result.ok, "reinstateCard が失敗した").toBe(true);

    const card = await repository().findById(cardId);
    expect(card?.status).toBe("active");
    expect(card?.ownerUserId).toBe("usr_taro");
    expect(card?.targetUrl).toBe("https://example.com/taro");
    expect(card?.disabledAt).toBeNull();
    expect(card?.disabledReason).toBeNull();
  });

  it("actorUserId をそのまま監査へ残し、新しいイベント名 card.reinstated を使う", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await rpc.disableCard({ actorUserId: ACTOR, cardId });

    await rpc.reinstateCard({ actorUserId: ACTOR, cardId });

    const rows = await db()
      .select()
      .from(nfcCardEvents)
      .where(eq(nfcCardEvents.cardId, cardId))
      .orderBy(desc(nfcCardEvents.id))
      .all();
    const reinstatedEvent = rows.find((row) => row.event === "card.reinstated");

    // **`card.disabled` の逆向きを記録したこれまでのイベントが無い**ので、
    // `releaseCard` とは違い新しい名前を使う（`retention-policy.ts` を参照）。
    expect(reinstatedEvent?.actorUserId).toBe(ACTOR);
    expect(reinstatedEvent?.metadata?.["actingAsAdmin"]).toBe(true);
  });

  it("既に active のカードへもう一度叩いても失敗にしない（冪等）", async () => {
    const cardId = await seedActiveCard("usr_taro");

    const result = await rpc.reinstateCard({ actorUserId: ACTOR, cardId });

    expect(result.ok).toBe(true);
  });

  it("issued（一度も無効化されていない）のカードは復帰の対象外", async () => {
    const cardId = await seedIssuedCard();

    const result = await rpc.reinstateCard({ actorUserId: ACTOR, cardId });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("存在しないカードは not_found", async () => {
    const result = await rpc.reinstateCard({ actorUserId: ACTOR, cardId: "nfc_does_not_exist" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("入力の形が崩れていれば invalid_input で落ちる", async () => {
    const result = await rpc.reinstateCard({ actorUserId: "", cardId: "" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("invalid_input");
  });
});

describe("reinstateCardToIssued", () => {
  it("所有者の無い disabled カードを issued へ戻す", async () => {
    const cardId = await seedIssuedCard();
    await rpc.disableCard({ actorUserId: ACTOR, cardId });

    const result = await rpc.reinstateCardToIssued({ actorUserId: ACTOR, cardId });

    expect(result.ok, "reinstateCardToIssued が失敗した").toBe(true);
    const card = await repository().findById(cardId);
    expect(card?.status).toBe("issued");
    expect(card?.ownerUserId).toBeNull();
    expect(card?.disabledAt).toBeNull();
    expect(card?.disabledReason).toBeNull();
  });

  it("所有者のいるカードは対象外——reinstateCard（→ active）との呼び分けの核心", async () => {
    // **これが #450 レビューの本体。** `reinstateCard` を所有者ありの
    // カードへそのまま使わせ、こちらは所有者無しだけを受け付ける。
    const cardId = await seedActiveCard("usr_taro");
    await rpc.disableCard({ actorUserId: ACTOR, cardId });

    const result = await rpc.reinstateCardToIssued({ actorUserId: ACTOR, cardId });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("not_found");
    const card = await repository().findById(cardId);
    expect(card?.status).toBe("disabled");
    expect(card?.ownerUserId).toBe("usr_taro");
  });

  it("actorUserId をそのまま監査へ残し、card.reinstated を使う", async () => {
    const cardId = await seedIssuedCard();
    await rpc.disableCard({ actorUserId: ACTOR, cardId });

    await rpc.reinstateCardToIssued({ actorUserId: ACTOR, cardId });

    const rows = await db()
      .select()
      .from(nfcCardEvents)
      .where(eq(nfcCardEvents.cardId, cardId))
      .orderBy(desc(nfcCardEvents.id))
      .all();
    const reinstatedEvent = rows.find((row) => row.event === "card.reinstated");

    expect(reinstatedEvent?.actorUserId).toBe(ACTOR);
    expect(reinstatedEvent?.metadata?.["actingAsAdmin"]).toBe(true);
  });

  it("既に issued のカードへもう一度叩いても失敗にしない（冪等）", async () => {
    const cardId = await seedIssuedCard();

    const result = await rpc.reinstateCardToIssued({ actorUserId: ACTOR, cardId });

    expect(result.ok).toBe(true);
  });

  it("存在しないカードは not_found", async () => {
    const result = await rpc.reinstateCardToIssued({
      actorUserId: ACTOR,
      cardId: "nfc_does_not_exist",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("入力の形が崩れていれば invalid_input で落ちる", async () => {
    const result = await rpc.reinstateCardToIssued({ actorUserId: "", cardId: "" });

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

describe("countBatchIssuedCards", () => {
  it("issued のカードだけを数え、active・disabled は数えない", async () => {
    await seedIssuedCard("bunkasai-2026");
    await seedIssuedCard("bunkasai-2026");
    // 同じバッチ名でも active（誰かのもの）は数えない。
    await seedActiveCardWithBatch("usr_taro", "bunkasai-2026");
    await seedIssuedCard("other-batch");

    const result = await rpc.countBatchIssuedCards({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    expect(result.ok, "countBatchIssuedCards が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(2);
  });

  it("書き込まない。カードの状態は変わらない", async () => {
    const cardId = await seedIssuedCard("bunkasai-2026");

    await rpc.countBatchIssuedCards({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    const card = await repository().findById(cardId);
    expect(card?.status).toBe("issued");
  });

  it("該当が無ければ 0", async () => {
    const result = await rpc.countBatchIssuedCards({ actorUserId: ACTOR, batch: "no-such-batch" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(0);
  });

  it("入力の形が崩れていれば invalid_input で落ちる", async () => {
    const result = await rpc.countBatchIssuedCards({ actorUserId: "", batch: "" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("invalid_input");
  });
});

describe("batchDisableCards", () => {
  it("バッチ内の issued カードを一括無効化し、active は対象外にする", async () => {
    const issuedA = await seedIssuedCard("bunkasai-2026");
    const issuedB = await seedIssuedCard("bunkasai-2026");
    // 同じバッチ名でも active は対象外にすること自体を確かめる。
    const active = await seedActiveCardWithBatch("usr_taro", "bunkasai-2026");
    const otherBatch = await seedIssuedCard("other-batch");

    const result = await rpc.batchDisableCards({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    expect(result.ok, "batchDisableCards が失敗した").toBe(true);
    if (!result.ok) return;
    expect(new Set(result.value.cardIds)).toEqual(new Set([issuedA, issuedB]));

    expect((await repository().findById(issuedA))?.isDisabled).toBe(true);
    expect((await repository().findById(issuedB))?.isDisabled).toBe(true);
    // **active は対象外**（①の設計判断）。バッチ名が一致するだけでは巻き込まない。
    expect((await repository().findById(active))?.isDisabled).toBe(false);
    // 別バッチは無関係。
    expect((await repository().findById(otherBatch))?.isDisabled).toBe(false);
  });

  it("対象カードの数ぶん card.disabled を書き、metadata.batch を残す", async () => {
    const cardId = await seedIssuedCard("bunkasai-2026");

    await rpc.batchDisableCards({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    const rows = await db()
      .select()
      .from(nfcCardEvents)
      .where(eq(nfcCardEvents.cardId, cardId))
      .orderBy(desc(nfcCardEvents.id))
      .all();
    const disabledEvent = rows.find((row) => row.event === "card.disabled");

    // **イベント名は増やさない。** 単発の運営操作と同じ card.disabled を
    // 使い、metadata.batch で一括操作の一部だったことを残す。
    // **reason は単発操作と別の値（#436）** ——一括復帰が「このバッチ名で
    // 一括無効化された行だけ」を区別するのに要る（domain/services/
    // disabled-reason.ts を参照）。
    expect(disabledEvent?.actorUserId).toBe(ACTOR);
    expect(disabledEvent?.metadata?.["actingAsAdmin"]).toBe(true);
    expect(disabledEvent?.metadata?.["reason"]).toBe("admin_batch");
    expect(disabledEvent?.metadata?.["batch"]).toBe("bunkasai-2026");
  });

  it("既に無効化済みのカードを含む状態でもう一度叩いても失敗にしない（冪等）", async () => {
    await seedIssuedCard("bunkasai-2026");
    await rpc.batchDisableCards({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    const second = await rpc.batchDisableCards({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // 2 回目は対象 0 件。失敗にはしない。
    expect(second.value.cardIds).toHaveLength(0);
  });

  it("該当が無ければ 0 件を返す（失敗にしない）", async () => {
    const result = await rpc.batchDisableCards({ actorUserId: ACTOR, batch: "no-such-batch" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cardIds).toHaveLength(0);
  });

  it("入力の形が崩れていれば invalid_input で落ちる", async () => {
    const result = await rpc.batchDisableCards({ actorUserId: "", batch: "" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("invalid_input");
  });
});

describe("countDisabledInBatch", () => {
  it("そのバッチの一括無効化で止めたカードだけを数える", async () => {
    await seedIssuedCard("bunkasai-2026");
    await seedIssuedCard("bunkasai-2026");
    await rpc.batchDisableCards({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    const result = await rpc.countDisabledInBatch({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    expect(result.ok, "countDisabledInBatch が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(2);
  });

  it("同じバッチでも、単発の運営操作で止めたカードは数えない", async () => {
    // **これが #436 の本体。** `batch` 列が一致するだけでは、一括操作で
    // 止めたかは分からない——`disabled_reason` で区別する。
    await rpc.batchDisableCards({ actorUserId: ACTOR, batch: "bunkasai-2026" }); // 対象 0 件
    const individuallyDisabled = await seedIssuedCard("bunkasai-2026");
    await rpc.disableCard({ actorUserId: ACTOR, cardId: individuallyDisabled });

    const result = await rpc.countDisabledInBatch({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(0);
  });

  it("書き込まない。カードの状態は変わらない", async () => {
    const cardId = await seedIssuedCard("bunkasai-2026");
    await rpc.batchDisableCards({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    await rpc.countDisabledInBatch({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    const card = await repository().findById(cardId);
    expect(card?.status).toBe("disabled");
  });

  it("該当が無ければ 0", async () => {
    const result = await rpc.countDisabledInBatch({ actorUserId: ACTOR, batch: "no-such-batch" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(0);
  });

  it("入力の形が崩れていれば invalid_input で落ちる", async () => {
    const result = await rpc.countDisabledInBatch({ actorUserId: "", batch: "" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("invalid_input");
  });
});

describe("reinstateBatchToIssuedCards", () => {
  it("バッチ一括無効化で止めたカードを issued へ戻す", async () => {
    const cardA = await seedIssuedCard("bunkasai-2026");
    const cardB = await seedIssuedCard("bunkasai-2026");
    await rpc.batchDisableCards({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    const result = await rpc.reinstateBatchToIssuedCards({
      actorUserId: ACTOR,
      batch: "bunkasai-2026",
    });

    expect(result.ok, "reinstateBatchToIssuedCards が失敗した").toBe(true);
    if (!result.ok) return;
    expect(new Set(result.value.cardIds)).toEqual(new Set([cardA, cardB]));

    const restoredA = await repository().findById(cardA);
    expect(restoredA?.status).toBe("issued");
    expect(restoredA?.ownerUserId).toBeNull();
    expect(restoredA?.disabledAt).toBeNull();
    expect(restoredA?.disabledReason).toBeNull();
  });

  it("同じバッチでも、単発の運営操作で止めたカードは戻さない", async () => {
    await rpc.batchDisableCards({ actorUserId: ACTOR, batch: "bunkasai-2026" }); // 対象 0 件
    const individuallyDisabled = await seedIssuedCard("bunkasai-2026");
    await rpc.disableCard({ actorUserId: ACTOR, cardId: individuallyDisabled });

    const result = await rpc.reinstateBatchToIssuedCards({
      actorUserId: ACTOR,
      batch: "bunkasai-2026",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cardIds).toHaveLength(0);
    // **個別に止めた理由を、一括操作が消してはいけない。**
    expect((await repository().findById(individuallyDisabled))?.status).toBe("disabled");
  });

  it("active（誰かのもの）を単発操作で止めても対象外（disabled_reason の不一致で先に弾かれる）", async () => {
    // `disableCard`（単発の運営操作）は reason を "admin_action" で書くので、
    // ここでは `disabled_reason` の不一致だけで既に弾かれる。`owner_user_id
    // is null` の境界そのものを割った状態（#436 の保険）は、通常の UseCase
    // からは作れない——`card.repository.test.ts` の直接呼び出しで確かめる。
    const active = await seedActiveCardWithBatch("usr_taro", "bunkasai-2026");
    await rpc.disableCard({ actorUserId: ACTOR, cardId: active });

    const result = await rpc.reinstateBatchToIssuedCards({
      actorUserId: ACTOR,
      batch: "bunkasai-2026",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cardIds).toHaveLength(0);
  });

  it("actorUserId をそのまま監査へ残し、card.reinstated に metadata.batch を残す", async () => {
    const cardId = await seedIssuedCard("bunkasai-2026");
    await rpc.batchDisableCards({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    await rpc.reinstateBatchToIssuedCards({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    const rows = await db()
      .select()
      .from(nfcCardEvents)
      .where(eq(nfcCardEvents.cardId, cardId))
      .orderBy(desc(nfcCardEvents.id))
      .all();
    const reinstatedEvent = rows.find((row) => row.event === "card.reinstated");

    // **新しいイベント名は増やさない。** #427 で新設した card.reinstated を
    // 使い回す（DelegatedReinstateCardUseCase と同じ名前）。
    expect(reinstatedEvent?.actorUserId).toBe(ACTOR);
    expect(reinstatedEvent?.metadata?.["actingAsAdmin"]).toBe(true);
    expect(reinstatedEvent?.metadata?.["batch"]).toBe("bunkasai-2026");
  });

  it("既に issued へ戻した後にもう一度叩いても失敗にしない（冪等）", async () => {
    await seedIssuedCard("bunkasai-2026");
    await rpc.batchDisableCards({ actorUserId: ACTOR, batch: "bunkasai-2026" });
    await rpc.reinstateBatchToIssuedCards({ actorUserId: ACTOR, batch: "bunkasai-2026" });

    const second = await rpc.reinstateBatchToIssuedCards({
      actorUserId: ACTOR,
      batch: "bunkasai-2026",
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.cardIds).toHaveLength(0);
  });

  it("該当が無ければ 0 件を返す（失敗にしない）", async () => {
    const result = await rpc.reinstateBatchToIssuedCards({
      actorUserId: ACTOR,
      batch: "no-such-batch",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cardIds).toHaveLength(0);
  });

  it("入力の形が崩れていれば invalid_input で落ちる", async () => {
    const result = await rpc.reinstateBatchToIssuedCards({ actorUserId: "", batch: "" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("invalid_input");
  });
});
