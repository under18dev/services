import { describe, expect, it } from "vitest";
import { Card, type CardProps, type CardStatus } from "../src/domain/entities/card";
import { discloseCard, isConcealedForClaim } from "../src/domain/services/disclosure";

/**
 * **`disclosure.ts` の表を、コメントではなく検査にする**（#358）。
 *
 * あのファイルには「どの状態がどちらの入口で何になるか」が表で書いてある。
 * **表はコメントのままだと腐る** —— 今日だけで、嘘になった説明文が
 * 4 回見つかっている。入口は 2 つあり、**片方だけ緩める変更は
 * ここが落ちない限り通ってしまう。**
 *
 * ## D1 を使わない
 *
 * `Card.fromPersistence` で直接組む。この判断に永続化は要らず、
 * **組み合わせを全部並べるほうが大事**だからである。実際の経路は
 * `redirect.test.ts` と `claim.form.test.ts` が見ている。
 */

function card(overrides: Partial<CardProps> = {}): Card {
  const now = new Date("2026-10-30T00:00:00.000Z");
  return Card.fromPersistence({
    id: "nfc_tttttttttttttttttttt",
    ownerUserId: null,
    targetUrl: null,
    status: "issued",
    claimedAt: null,
    transferCount: 0,
    disabledAt: null,
    disabledReason: null,
    batch: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

/** `disclosure.ts` の表の行。**並びも文言もあちらに合わせてある。** */
const TABLE = [
  {
    label: "存在しない",
    card: null,
    tap: "concealed",
    concealedForClaim: true,
  },
  {
    label: "issued（未紐づけ）",
    card: card({ status: "issued", ownerUserId: null }),
    tap: "claimable",
    concealedForClaim: false,
  },
  {
    label: "active + 遷移先あり",
    card: card({ status: "active", ownerUserId: "usr_taro", targetUrl: "https://example.com/" }),
    tap: "resolvable",
    concealedForClaim: true,
  },
  {
    label: "active + 遷移先なし",
    card: card({ status: "active", ownerUserId: "usr_taro", targetUrl: null }),
    tap: "concealed",
    concealedForClaim: true,
  },
  {
    label: "disabled",
    card: card({
      status: "disabled",
      ownerUserId: "usr_taro",
      targetUrl: "https://example.com/",
      disabledAt: new Date("2026-10-30T00:00:00.000Z"),
      disabledReason: "lost",
    }),
    tap: "concealed",
    concealedForClaim: true,
  },
] as const;

describe("disclosure.ts の表", () => {
  it.each(TABLE.map((row) => [row.label, row] as const))(
    "%s をタップしたときの扱い",
    (_label, row) => {
      expect(discloseCard(row.card).kind).toBe(row.tap);
    },
  );

  it.each(TABLE.map((row) => [row.label, row] as const))(
    "%s を紐づけ画面から見たときの扱い",
    (_label, row) => {
      expect(isConcealedForClaim(discloseCard(row.card))).toBe(row.concealedForClaim);
    },
  );

  it("区別できるのは issued だけ", () => {
    // **これが #358 で開けた 1 ビットである。** 他の行が `claimable` に
    // なったら、漏れる情報が 1 ビットでは済まなくなる。
    const claimable = TABLE.filter((row) => discloseCard(row.card).kind === "claimable");

    expect(claimable.map((row) => row.label)).toEqual(["issued（未紐づけ）"]);
  });

  it("紐づけ画面は、他人のカードと存在しないカードを区別しない", () => {
    // `resolvable` と `concealed` の差は、タップの解決にしか無い。
    // 区別すると、カード ID の総当たりに意味が出る。
    const taken = TABLE.find((row) => row.label === "active + 遷移先あり")!;
    const missing = TABLE.find((row) => row.label === "存在しない")!;

    expect(discloseCard(taken.card).kind).not.toBe(discloseCard(missing.card).kind);
    expect(isConcealedForClaim(discloseCard(taken.card))).toBe(
      isConcealedForClaim(discloseCard(missing.card)),
    );
  });

  it("disabled は、存在しないカードと同じ扱いのまま", () => {
    // **一緒に緩めないこと。** 紛失対策の本体で、`issued` を区別する
    // 変更に巻き込まれやすいのがここである。
    const disabled = TABLE.find((row) => row.label === "disabled")!;
    const missing = TABLE.find((row) => row.label === "存在しない")!;

    expect(discloseCard(disabled.card)).toEqual(discloseCard(missing.card));
  });

  it("表が、カードの状態を全部並べている", () => {
    // **0 件ガードの逆。** `CardStatus` に 4 つ目が増えたのに表が
    // 3 つのままだと、増えた状態は誰も見ないまま通る。
    const statuses: readonly CardStatus[] = ["issued", "active", "disabled"];
    const covered = new Set(
      TABLE.filter((row) => row.card !== null).map((row) => row.card!.status),
    );

    expect([...covered].sort()).toEqual([...statuses].sort());
  });

  it("遷移先が https: でなければ解決しない", () => {
    // `isResolvable()` が最後に見ているところ。DB を直接書き換えられた
    // 場合や、検証規則を後から厳しくした場合に、古い行が配信されない。
    const httpCard = card({
      status: "active",
      ownerUserId: "usr_taro",
      targetUrl: "http://example.com/",
    });

    expect(discloseCard(httpCard).kind).toBe("concealed");
  });
});
