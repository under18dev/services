import { newCardId } from "@u18/domain";
import { nfcCards } from "@u18/nfc-db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_BATCH_DISABLED_REASON } from "../src/domain/services/disabled-reason";
import { db, repository, resetDatabase, seedActiveCard, seedIssuedCard } from "./helpers";

/**
 * 状態遷移の前提条件が **WHERE 句に入っていること**を、本物の D1 で確かめる。
 *
 * UseCase 側のチェックだけでは、確認と書き込みの間に状態が変わる
 * 競合を塞げない（仕様書 7.3）。ここは Repository を直接叩いて、
 * 条件付き UPDATE が単体で正しく落ちることを固定する。
 */

beforeEach(resetDatabase);

/**
 * **`listAll(limit)` は `limit + 1` 件返す**（#338 Step 3 / #433）。
 *
 * 多い 1 件は「まだ先がある」の合図で、呼ぶ側
 * （`DelegatedListAllCardsUseCase`）が `truncated` に畳んで切り落とす。
 * **約束が崩れると `truncated` が常に false になる** —— 運営は全部を見た
 * つもりで一部を見ることになり、画面も RPC も落ちない。
 *
 * **ここで見るのは #433 以降である。** それまでは
 * `apps/nfc-worker/test/admin.ui.test.ts` が `/account/nfc/admin` の画面を
 * 引いて「上限で切ったことが出ている」を見ていたが、**あの画面ごと消えた。**
 * 実際の上限（`MAX_ADMIN_LIST` = 500）を埋めるのは時間に見合わないので、
 * **小さい `limit` で約束そのものを見る。**
 */
describe("listAll", () => {
  it("limit より多く在れば limit + 1 件返す", async () => {
    for (let i = 0; i < 3; i += 1) await seedIssuedCard();

    expect(await repository().listAll(2)).toHaveLength(3);
  });

  it("limit 以下しか無ければ、在るだけ返す", async () => {
    await seedIssuedCard();
    await seedIssuedCard();

    // **`limit + 1` を返すのは「先がある」ときだけ。** ここが 3 件に
    // なると、2 枚しか無いのに `truncated` が立つ。
    expect(await repository().listAll(2)).toHaveLength(2);
  });

  /**
   * **`batch` は打ち切り（`limit + 1`）の前に効くこと**（#481）。
   * 絞ったあとの件数で `limit + 1` を取るので、対象のロットが
   * 全体では 500 枚より後ろに並んでいても、ちゃんと見える。
   */
  it("batch を渡すと、そのロットだけに絞ってから limit + 1 件を取る", async () => {
    await seedIssuedCard("2026-bunkasai");
    await seedIssuedCard("2026-bunkasai");
    await seedIssuedCard("other-lot");

    const rows = await repository().listAll(10, { batch: "2026-bunkasai" });
    expect(rows).toHaveLength(2);
    expect(rows.every((card) => card.batch === "2026-bunkasai")).toBe(true);
  });

  it("batch を渡さなければ、これまでどおり全件を見る", async () => {
    await seedIssuedCard("2026-bunkasai");
    await seedIssuedCard("other-lot");

    expect(await repository().listAll(10)).toHaveLength(2);
  });
});

describe("updateTarget", () => {
  it("所有者でなければ false を返し、行も変わらない", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");

    const updated = await repository().updateTarget(
      cardId,
      "usr_hanako",
      "https://evil.example/",
      new Date(),
    );

    expect(updated).toBe(false);
    expect((await repository().findById(cardId))?.targetUrl).toBe("https://example.com/taro");
  });

  it("未紐づけのカードは更新できない", async () => {
    const cardId = await seedIssuedCard();

    const updated = await repository().updateTarget(
      cardId,
      "usr_taro",
      "https://example.com/x",
      new Date(),
    );

    expect(updated).toBe(false);
  });

  it("存在しないカードでも例外を投げない", async () => {
    const updated = await repository().updateTarget(
      newCardId(),
      "usr_taro",
      "https://example.com/x",
      new Date(),
    );

    expect(updated).toBe(false);
  });
});

describe("claim", () => {
  it("未紐づけなら、カード ID を知っているだけで通る", async () => {
    // **#358 の本体。** 以前は紐づけコードの一致を WHERE 句で要求していた。
    const cardId = await seedIssuedCard();

    expect(await repository().claim(cardId, "usr_taro", new Date())).toBe(true);
    expect((await repository().findById(cardId))?.ownerUserId).toBe("usr_taro");
  });

  it("所有者がいるカードは奪えない", async () => {
    const cardId = await seedActiveCard("usr_taro");

    expect(await repository().claim(cardId, "usr_hanako", new Date())).toBe(false);
    expect((await repository().findById(cardId))?.ownerUserId).toBe("usr_taro");
  });

  it("無効化済みのカードは紐づけられない", async () => {
    // **紛失対策の本体。** 拾った人がタップして自分のものにできてはならない。
    const cardId = await seedActiveCard("usr_taro");
    await repository().disable(cardId, "usr_taro", "lost", new Date());

    expect(await repository().claim(cardId, "usr_hanako", new Date())).toBe(false);
    expect((await repository().findById(cardId))?.ownerUserId).toBe("usr_taro");
  });

  it("存在しないカードでも例外を投げない", async () => {
    expect(await repository().claim(newCardId(), "usr_taro", new Date())).toBe(false);
  });

  it("同じカードを 2 人が同時にタップしても、通るのは 1 人だけ", async () => {
    // **これが WHERE 句に前提を入れている理由である。** #358 で紐づけ
    // コードが無くなり、ID を知っていれば誰でも投げられるようになったので、
    // 競合は以前より起こしやすい。
    const cardId = await seedIssuedCard();

    const results = await Promise.all([
      repository().claim(cardId, "usr_taro", new Date()),
      repository().claim(cardId, "usr_hanako", new Date()),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("初回の紐づけは移転として数えない", async () => {
    const cardId = await seedIssuedCard();
    await repository().claim(cardId, "usr_taro", new Date());

    expect((await repository().findById(cardId))?.transferCount).toBe(0);
  });

  it("手放したあとの紐づけは移転として数える", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await repository().release(cardId, "usr_taro", new Date());

    expect(await repository().claim(cardId, "usr_hanako", new Date())).toBe(true);
    expect((await repository().findById(cardId))?.transferCount).toBe(1);
  });
});

describe("disable / release", () => {
  it("無効化しても所有者を残す", async () => {
    // 所有者を外すと `issued` と区別が付かなくなり、**#358 以降は拾った人が
    // タップするだけで自分のものにできてしまう。**
    const cardId = await seedActiveCard("usr_taro");

    await repository().disable(cardId, "usr_taro", "lost", new Date());

    const card = await repository().findById(cardId);
    expect(card?.status).toBe("disabled");
    expect(card?.ownerUserId).toBe("usr_taro");
    expect(card?.isResolvable()).toBe(false);
  });

  it("手放すと issued に戻り、遷移先が消える", async () => {
    const cardId = await seedActiveCard("usr_taro");

    const released = await repository().release(cardId, "usr_taro", new Date());

    expect(released).toBe(true);
    const card = await repository().findById(cardId);
    expect(card?.status).toBe("issued");
    expect(card?.ownerUserId).toBeNull();
    // 次の所有者のカードが、本人の知らない URL を配信した状態で始まらない。
    expect(card?.targetUrl).toBeNull();
    // **#358 以降、手放した瞬間から誰でも紐づけられる。**
    expect(card?.isClaimable()).toBe(true);
  });

  it("所有者でなければ手放せない", async () => {
    const cardId = await seedActiveCard("usr_taro");

    expect(await repository().release(cardId, "usr_hanako", new Date())).toBe(false);
    expect((await repository().findById(cardId))?.ownerUserId).toBe("usr_taro");
  });

  it("無効化済みのカードは手放せない", async () => {
    // 手放せると、紛失して止めたカードが再び紐づけ可能な状態へ戻る。
    const cardId = await seedActiveCard("usr_taro");
    await repository().disable(cardId, "usr_taro", "lost", new Date());

    expect(await repository().release(cardId, "usr_taro", new Date())).toBe(false);
  });
});

describe("reinstateAsAdmin", () => {
  it("所有者の無い disabled カードへは効かない——所有者の無いまま active になる事故を防ぐ（#450 のレビュー）", async () => {
    const cardId = await seedIssuedCard();
    await repository().disableAsAdmin(cardId, "admin_action", new Date());

    const reinstated = await repository().reinstateAsAdmin(cardId, new Date());

    expect(reinstated).toBe(false);
    const card = await repository().findById(cardId);
    expect(card?.status).toBe("disabled");
    expect(card?.ownerUserId).toBeNull();
  });

  it("所有者のいる disabled カードは従来どおり active へ戻す", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await repository().disable(cardId, "usr_taro", "lost", new Date());

    expect(await repository().reinstateAsAdmin(cardId, new Date())).toBe(true);
    expect((await repository().findById(cardId))?.status).toBe("active");
  });
});

describe("reinstateToIssuedAsAdmin", () => {
  it("所有者の無い disabled カードを issued へ戻す", async () => {
    const cardId = await seedIssuedCard();
    await repository().disableAsAdmin(cardId, "admin_action", new Date());

    const reinstated = await repository().reinstateToIssuedAsAdmin(cardId, new Date());

    expect(reinstated).toBe(true);
    const card = await repository().findById(cardId);
    expect(card?.status).toBe("issued");
    expect(card?.ownerUserId).toBeNull();
    expect(card?.disabledAt).toBeNull();
    expect(card?.disabledReason).toBeNull();
  });

  it("理由コードを問わない（単発で名指しする操作のため、admin_batch で止めた行も戻せる）", async () => {
    const cardId = await seedIssuedCard("bunkasai-2026");
    await repository().disableBatchAsAdmin(
      "bunkasai-2026",
      ADMIN_BATCH_DISABLED_REASON,
      new Date(),
    );

    expect(await repository().reinstateToIssuedAsAdmin(cardId, new Date())).toBe(true);
  });

  it("所有者がいれば戻さない——reinstateAsAdmin（→ active）との呼び分けの核心", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await repository().disable(cardId, "usr_taro", "lost", new Date());

    const reinstated = await repository().reinstateToIssuedAsAdmin(cardId, new Date());

    expect(reinstated).toBe(false);
    const card = await repository().findById(cardId);
    expect(card?.status).toBe("disabled");
    expect(card?.ownerUserId).toBe("usr_taro");
  });

  it("issued（一度も無効化されていない）のカードには効かない", async () => {
    const cardId = await seedIssuedCard();

    expect(await repository().reinstateToIssuedAsAdmin(cardId, new Date())).toBe(false);
  });

  it("存在しないカードでも例外を投げない", async () => {
    expect(await repository().reinstateToIssuedAsAdmin(newCardId(), new Date())).toBe(false);
  });
});

describe("reinstateBatchToIssuedAsAdmin", () => {
  it("そのバッチの、一括無効化専用の理由コードを持つ行だけを issued へ戻す", async () => {
    const cardId = await seedIssuedCard("bunkasai-2026");
    await repository().disableBatchAsAdmin(
      "bunkasai-2026",
      ADMIN_BATCH_DISABLED_REASON,
      new Date(),
    );

    const rows = await repository().reinstateBatchToIssuedAsAdmin("bunkasai-2026", new Date());

    expect(rows.map((row) => row.id)).toEqual([cardId]);
    const card = await repository().findById(cardId);
    expect(card?.status).toBe("issued");
    expect(card?.disabledAt).toBeNull();
    expect(card?.disabledReason).toBeNull();
  });

  it("理由コードが違えば戻さない（単発の運営操作との区別）", async () => {
    const cardId = await seedIssuedCard("bunkasai-2026");
    await repository().disableBatchAsAdmin("bunkasai-2026", "admin_action", new Date());

    const rows = await repository().reinstateBatchToIssuedAsAdmin("bunkasai-2026", new Date());

    expect(rows).toHaveLength(0);
    expect((await repository().findById(cardId))?.status).toBe("disabled");
  });

  it("owner_user_id が付いていれば、理由コードが一致していても戻さない（#436 の保険）", async () => {
    // **通常の UseCase からはこの行は作れない**（`disableBatchAsAdmin` は
    // `issued` しか対象にせず、`issued` は所有者を持たない）。WHERE 句の
    // `owner_user_id is null` がそれ自体で守っていることを、行を直接
    // 書き換えて確かめる。
    const cardId = await seedActiveCard("usr_taro");
    await repository().disable(cardId, "usr_taro", "lost", new Date());
    await db()
      .update(nfcCards)
      .set({ batch: "bunkasai-2026", disabledReason: ADMIN_BATCH_DISABLED_REASON })
      .where(eq(nfcCards.id, cardId))
      .run();

    const rows = await repository().reinstateBatchToIssuedAsAdmin("bunkasai-2026", new Date());

    expect(rows).toHaveLength(0);
    const card = await repository().findById(cardId);
    expect(card?.status).toBe("disabled");
    expect(card?.ownerUserId).toBe("usr_taro");
  });

  it("別バッチには触らない", async () => {
    const cardId = await seedIssuedCard("other-batch");
    await repository().disableBatchAsAdmin("other-batch", ADMIN_BATCH_DISABLED_REASON, new Date());

    const rows = await repository().reinstateBatchToIssuedAsAdmin("bunkasai-2026", new Date());

    expect(rows).toHaveLength(0);
    expect((await repository().findById(cardId))?.status).toBe("disabled");
  });

  it("既に issued のカードには影響しない（冪等の根拠）", async () => {
    await seedIssuedCard("bunkasai-2026");

    const rows = await repository().reinstateBatchToIssuedAsAdmin("bunkasai-2026", new Date());

    expect(rows).toHaveLength(0);
  });
});

describe("countDisabledInBatch", () => {
  it("reinstateBatchToIssuedAsAdmin と同じ条件で数える", async () => {
    await seedIssuedCard("bunkasai-2026");
    await seedIssuedCard("bunkasai-2026");
    await repository().disableBatchAsAdmin(
      "bunkasai-2026",
      ADMIN_BATCH_DISABLED_REASON,
      new Date(),
    );
    // 単発操作で止めた 1 枚は数えない。
    const individuallyDisabled = await seedIssuedCard("bunkasai-2026");
    await repository().disableAsAdmin(individuallyDisabled, "admin_action", new Date());

    expect(await repository().countDisabledInBatch("bunkasai-2026")).toBe(2);
  });

  it("該当が無ければ 0", async () => {
    expect(await repository().countDisabledInBatch("no-such-batch")).toBe(0);
  });
});

describe("listByOwner", () => {
  it("所有者のカードだけを返す", async () => {
    await seedActiveCard("usr_taro");
    await seedActiveCard("usr_taro");
    await seedActiveCard("usr_hanako");

    expect(await repository().listByOwner("usr_taro")).toHaveLength(2);
    expect(await repository().listByOwner("usr_hanako")).toHaveLength(1);
    expect(await repository().listByOwner("usr_unknown")).toHaveLength(0);
  });

  it("未紐づけのカードはどのユーザーにも属さない", async () => {
    await seedIssuedCard();
    expect(await repository().listByOwner("usr_taro")).toHaveLength(0);
  });
});

describe("countTotal / countClaimedEver（#454）", () => {
  it("countTotal は status を問わず全カードを数える", async () => {
    await seedIssuedCard();
    await seedActiveCard("usr_taro");
    const disabled = await seedActiveCard("usr_hanako");
    await repository().disable(disabled, "usr_hanako", "lost", new Date());

    expect(await repository().countTotal()).toBe(3);
  });

  it("countClaimedEver は、無効化されても active だった事実を数え続ける", async () => {
    await seedActiveCard("usr_taro");
    const disabledAfterActive = await seedActiveCard("usr_hanako");
    await repository().disable(disabledAfterActive, "usr_hanako", "lost", new Date());
    await seedIssuedCard(); // 一度も紐づいていない

    expect(await repository().countClaimedEver()).toBe(2);
    // 参考: status だけで数えると active の 1 枚しか見えない
    // （disabled 側は `disabledReasonBreakdown` のテストが確かめている）。
    const card = await repository().findById(disabledAfterActive);
    expect(card?.status).toBe("disabled");
    expect(card?.claimedAt).not.toBeNull();
  });

  it("1 枚も無ければ 0", async () => {
    expect(await repository().countTotal()).toBe(0);
    expect(await repository().countClaimedEver()).toBe(0);
  });
});

describe("disabledReasonBreakdown（#454）", () => {
  it("disabled のカードだけを reason 別に数える。issued / active は含めない", async () => {
    const a = await seedActiveCard("usr_taro");
    await repository().disable(a, "usr_taro", "lost", new Date());
    const b = await seedActiveCard("usr_hanako");
    await repository().disable(b, "usr_hanako", "lost", new Date());
    const c = await seedIssuedCard("bunkasai-2026");
    await repository().disableAsAdmin(c, "admin_batch", new Date());
    await seedIssuedCard(); // disabled ではない

    const rows = await repository().disabledReasonBreakdown();

    expect(rows).toEqual(
      expect.arrayContaining([
        { reason: "lost", count: 2 },
        { reason: "admin_batch", count: 1 },
      ]),
    );
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(3);
  });

  it("1 枚も無効化されていなければ空配列", async () => {
    await seedIssuedCard();
    expect(await repository().disabledReasonBreakdown()).toEqual([]);
  });
});

describe("transferCountDistribution（#454）", () => {
  it("0 / 1 / 2 / 3 以上に束ねる", async () => {
    await seedIssuedCard(); // transferCount 0

    const oneTransfer = await seedActiveCard("usr_taro");
    await repository().release(oneTransfer, "usr_taro", new Date());
    await repository().claim(oneTransfer, "usr_hanako", new Date()); // 1

    const threeTransfers = await seedIssuedCard();
    await repository().claim(threeTransfers, "usr_a", new Date()); // 初回は数えない
    await repository().release(threeTransfers, "usr_a", new Date());
    await repository().claim(threeTransfers, "usr_b", new Date()); // 1
    await repository().release(threeTransfers, "usr_b", new Date());
    await repository().claim(threeTransfers, "usr_c", new Date()); // 2
    await repository().release(threeTransfers, "usr_c", new Date());
    await repository().claim(threeTransfers, "usr_d", new Date()); // 3

    const distribution = await repository().transferCountDistribution();

    expect(distribution.zero).toBe(1);
    expect(distribution.one).toBe(1);
    expect(distribution.two).toBe(0);
    expect(distribution.threeOrMore).toBe(1);
  });

  it("1 枚も無ければ全部 0", async () => {
    expect(await repository().transferCountDistribution()).toEqual({
      zero: 0,
      one: 0,
      two: 0,
      threeOrMore: 0,
    });
  });
});
