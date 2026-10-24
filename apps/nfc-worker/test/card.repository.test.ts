import { newId } from "@u18/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { CLAIM_CODE_TTL_MS } from "../src/domain/entities/card";
import { claimCodes, repository, resetDatabase, seedActiveCard, seedIssuedCard } from "./helpers";

/**
 * 状態遷移の前提条件が **WHERE 句に入っていること**を、本物の D1 で確かめる。
 *
 * UseCase 側のチェックだけでは、確認と書き込みの間に状態が変わる
 * 競合を塞げない（仕様書 7.3）。ここは Repository を直接叩いて、
 * 条件付き UPDATE が単体で正しく落ちることを固定する。
 */

beforeEach(resetDatabase);

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
    const { cardId } = await seedIssuedCard();

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
      newId("nfc", 20),
      "usr_taro",
      "https://example.com/x",
      new Date(),
    );

    expect(updated).toBe(false);
  });
});

describe("claim", () => {
  it("期限切れの紐づけコードは通らない", async () => {
    const { cardId, claimCode } = await seedIssuedCard();

    // 未使用のコードが印刷物として残り続けることを避けるための期限。
    const claimableSince = new Date(Date.now() + 1000);
    const claimed = await repository().claim(
      cardId,
      await claimCodes.hash(claimCode),
      "usr_taro",
      claimableSince,
      new Date(),
    );

    expect(claimed).toBe(false);
    expect((await repository().findById(cardId))?.ownerUserId).toBeNull();
  });

  it("期限内なら通る", async () => {
    const { cardId, claimCode } = await seedIssuedCard();

    const claimed = await repository().claim(
      cardId,
      await claimCodes.hash(claimCode),
      "usr_taro",
      new Date(Date.now() - CLAIM_CODE_TTL_MS),
      new Date(),
    );

    expect(claimed).toBe(true);
  });

  it("成功したらコードを消費する", async () => {
    const { cardId, claimCode } = await seedIssuedCard();
    const hash = await claimCodes.hash(claimCode);
    const claimableSince = new Date(Date.now() - CLAIM_CODE_TTL_MS);

    expect(await repository().claim(cardId, hash, "usr_taro", claimableSince, new Date())).toBe(
      true,
    );
    // 消費しないと、同じ紙片を持つ相手が release 後に何度でも claim し直せる。
    expect((await repository().findById(cardId))?.claimCodeHash).toBeNull();
  });

  it("初回の紐づけは移転として数えない", async () => {
    const { cardId, claimCode } = await seedIssuedCard();
    await repository().claim(
      cardId,
      await claimCodes.hash(claimCode),
      "usr_taro",
      new Date(Date.now() - CLAIM_CODE_TTL_MS),
      new Date(),
    );

    expect((await repository().findById(cardId))?.transferCount).toBe(0);
  });
});

describe("disable / release", () => {
  it("無効化しても所有者を残す", async () => {
    // 所有者を外すと `issued` と区別が付かなくなり、拾った人間が
    // 紐づけコードを持っていた場合に自分のものにできてしまう。
    const cardId = await seedActiveCard("usr_taro");

    await repository().disable(cardId, "usr_taro", "lost", new Date());

    const card = await repository().findById(cardId);
    expect(card?.status).toBe("disabled");
    expect(card?.ownerUserId).toBe("usr_taro");
    expect(card?.isResolvable()).toBe(false);
  });

  it("手放すと issued に戻り、新しいコードが入る", async () => {
    const cardId = await seedActiveCard("usr_taro");

    const released = await repository().release(cardId, "usr_taro", "newhash", new Date());

    expect(released).toBe(true);
    const card = await repository().findById(cardId);
    expect(card?.status).toBe("issued");
    expect(card?.ownerUserId).toBeNull();
    expect(card?.targetUrl).toBeNull();
    expect(card?.claimCodeHash).toBe("newhash");
  });

  it("所有者でなければ手放せない", async () => {
    const cardId = await seedActiveCard("usr_taro");

    expect(await repository().release(cardId, "usr_hanako", "newhash", new Date())).toBe(false);
    expect((await repository().findById(cardId))?.ownerUserId).toBe("usr_taro");
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
