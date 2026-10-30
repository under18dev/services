import { describe, expect, it } from "vitest";
import { newId, newSessionId, newUserId } from "../src/identifier";

describe("newId", () => {
  it("接頭辞をつけて返す", () => {
    expect(newUserId()).toMatch(/^usr_[0-9a-z]{16}$/);
    expect(newSessionId()).toMatch(/^ses_[0-9a-z]{16}$/);
  });

  it("連続生成で衝突しない", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId("t")));
    expect(ids.size).toBe(2000);
  });

  it("バイト長を指定できる", () => {
    expect(newId("t", 32)).toMatch(/^t_[0-9a-z]{32}$/);
  });

  /**
   * **ID の推測しにくさを数字で固定する（#358）。**
   *
   * ## なぜ上の検査では足りないのか
   *
   * 上の 3 本は `/^usr_[0-9a-z]{16}$/` を見ている。**`[0-9a-z]` は 36 記号**で、
   * 実際に使っている Crockford base32（`i l o u` を除く 32 文字）より**広い。**
   * つまり**長さは固定しているが、記号数は 1 度も見ていない。**
   *
   * 実測（2026-10-30）: `ALPHABET` を 32 記号から 16 記号へ半分にして
   * （**80 ビット → 64 ビット**）リポジトリ全体を走らせたところ、
   * **1468 本が 1 本も落ちなかった。**
   *
   * ## なぜいま要るのか
   *
   * `identifier.ts` のコメントが主張しているのは「**衝突しない**十分な
   * エントロピー」だけで、**当て推量できないこと**は 1 度も主張していない。
   * #358 で NFC カードの紐づけコードが外れると、**「カード ID を知っている
   * ことが所有の主張になる」**ので、推測しにくさが**機能要件に昇格する。**
   *
   * **新しい性質を乗せたことが読める形にしておく。** 80 ビットは十分
   * （10^6 枚を 10^5 req/s で引いても、どれかに当たるまで期待 1.9×10^5 年）
   * だが、**十分であることと、固定されていることは別である。**
   *
   * ## 定数を写さず、出てきた ID から数える
   *
   * `ALPHABET` を import して突き合わせると、**定数を書き換えたときに
   * 期待値も一緒に動いて何を変えても緑**になる。ここでは実際に引いた ID の
   * 文字を集めて数えているので、符号化の仕方が変わればこの数字が動く。
   *
   * 標本は 2000 本 × 16 文字 = 32,000 文字。32 記号のどれかが 1 度も
   * 出ない確率は 32 × (31/32)^32000 ≒ 10^-441 で、**揺らぎでは落ちない。**
   */
  it("記号数と既定の長さが、ID のビット数を決めている", () => {
    const ids = Array.from({ length: 2000 }, () => newId("t"));
    const body = (id: string): string => id.slice("t_".length);

    // **既定は 16 文字。** `newId` の `byteLength = 16` が 1 バイト 1 文字で出る。
    expect(new Set(ids.map((id) => body(id).length))).toEqual(new Set([16]));

    const symbols = new Set(ids.flatMap((id) => [...body(id)]));

    // **紛らわしい 4 文字を入れない。** これはエントロピーではなく、
    // 人が読み書きするための性質（Crockford base32）。**記号数の検査より
    // 先に見る** —— 記号数を変えずに差し替えられると、下の行では落ちない。
    for (const confusing of ["i", "l", "o", "u"]) {
      expect(symbols.has(confusing), `${confusing} は紛らわしいので使わない`).toBe(false);
    }

    expect(symbols.size, "記号数が 32 でない（ビット数が変わっている）").toBe(32);

    // 32 記号 × 16 文字 = 80 ビット。**この数字が #358 の前提である。**
    const bits = 16 * Math.log2(symbols.size);
    expect(bits, "カード ID のビット数が 80 から動いた").toBe(80);
  });
});
