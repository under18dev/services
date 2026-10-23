import { describe, expect, it } from "vitest";
import { EmailAddress, InvalidEmailAddressError } from "../src/email-address";

describe("EmailAddress", () => {
  it("ドメイン部だけを小文字へ正規化する", () => {
    expect(EmailAddress.create("Taro@Example.COM").value).toBe("Taro@example.com");
  });

  it("local 部の大文字小文字は別人の可能性があるので保持する", () => {
    const upper = EmailAddress.create("Taro@example.com");
    const lower = EmailAddress.create("taro@example.com");
    expect(upper.equals(lower)).toBe(false);
  });

  it("前後の空白を落とす", () => {
    expect(EmailAddress.create("  taro@example.com \n").value).toBe("taro@example.com");
  });

  it.each([
    ["空文字", ""],
    ["@ なし", "taro.example.com"],
    ["@ が 2 つ", "a@b@example.com"],
    ["TLD なし", "taro@localhost"],
    ["空白入り", "ta ro@example.com"],
    ["表示名つき", "Taro <taro@example.com>"],
  ])("%s を拒否する", (_label, raw) => {
    expect(() => EmailAddress.create(raw)).toThrow(InvalidEmailAddressError);
  });

  it("254 文字を超えるアドレスを拒否する", () => {
    const long = `${"a".repeat(250)}@example.com`;
    expect(() => EmailAddress.create(long)).toThrow(InvalidEmailAddressError);
  });

  it("ログ用のマスク表現では local 部を伏せる", () => {
    expect(EmailAddress.create("taro@example.com").masked).toBe("t***@example.com");
  });

  it("tryCreate は不正な入力で null を返す", () => {
    expect(EmailAddress.tryCreate("nope")).toBeNull();
  });
});
