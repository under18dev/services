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
