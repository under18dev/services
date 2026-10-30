import { describe, expect, it } from "vitest";
import { newCardId, newId, newSessionId, newUserId } from "../src/identifier";

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
   * **新しい性質を乗せたことが読める形にしておく。** 十分であることと、
   * 固定されていることは別である。
   *
   * ## ここが固定するのは「1 文字あたり」と「既定の長さ」だけ
   *
   * **呼び出しごとの長さはここでは決まらない**（`newId(prefix, byteLength)`）。
   * **ビット数が要件になっている呼び出し側は、その長さを自分で固定すること。**
   * 1 文字あたりの 5 ビットは全員が共有していて、**ここが動けば全員のビット数
   * が動く** —— だから記号数はここで見る。
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
  it("記号数が 1 文字あたりのビット数を決めていて、既定の長さは 16 である", () => {
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

    expect(symbols.size, "記号数が 32 でない").toBe(32);

    // **1 文字 = 5 ビット。これが全部の ID の土台である。**
    // ここが動くと、`newId` を呼んでいる側すべてのビット数が一緒に動く。
    const bitsPerSymbol = Math.log2(symbols.size);
    expect(bitsPerSymbol, "1 文字あたりのビット数が 5 から動いた").toBe(5);

    // **既定（16 文字）は 80 ビット。** 長さを渡した呼び出しには当てはまらない。
    expect(16 * bitsPerSymbol, "既定の長さのビット数が 80 から動いた").toBe(80);
  });
});

describe("newCardId", () => {
  /**
   * **ここだけ既定の 16 バイトではない**（#358）。
   *
   * スキーマ・README・脅威モデルが揃って「100bit」と言っているのに、
   * **本番は `newId("nfc")` を呼んでいて 80bit を作っていた。** 長さが
   * 実装の 2 箇所（本番とテストヘルパ）に別々に書かれていたのが原因で、
   * **テストは一度も本番の ID 長を通していなかった。**
   *
   * #358 で紐づけコードを廃止したので、**カード ID が唯一の秘密**である。
   */
  it("nfc_ 接頭辞つきの 20 文字（= 100 ビット）", () => {
    expect(newCardId()).toMatch(/^nfc_[0-9abcdefghjkmnpqrstvwxyz]{20}$/);
  });

  it("文字集合に紛らわしい i l o u を含まない", () => {
    // 1 と l、0 と O の取り違えを避ける（Crockford base32）。
    // 印刷物から人が転記する場面がある。
    const ids = Array.from({ length: 200 }, () => newCardId()).join("");

    expect(ids).not.toMatch(/[ilou]/);
  });

  it("32 文字すべてが現れる（偏りが無いことの粗い確認）", () => {
    // 256 % 32 == 0 なので `byte % 32` に剰余の偏りは無い。
    // **一様性の証明にはならない**が、符号化が一部の文字しか出さない形に
    // 壊れたら落ちる。
    const chars = new Set(
      Array.from({ length: 500 }, () => newCardId().slice(4))
        .join("")
        .split(""),
    );

    expect(chars.size).toBe(32);
  });
});
