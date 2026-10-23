import { describe, expect, it } from "vitest";
import { InvalidUsernameError, Username } from "../src/username";

describe("Username", () => {
  it("小文字へ正規化する", () => {
    expect(Username.create("TanaHiro").value).toBe("tanahiro");
  });

  it("英数字とハイフン・アンダースコアを許可する", () => {
    expect(Username.create("u18_dev-01").value).toBe("u18_dev-01");
  });

  it.each([
    ["3 文字未満", "ab"],
    ["32 文字超", "a".repeat(33)],
    ["記号", "taro!"],
    ["先頭がハイフン", "-taro"],
    ["末尾がアンダースコア", "taro_"],
    ["予約語", "Admin"],
  ])("%s を拒否する", (_label, raw) => {
    expect(() => Username.create(raw)).toThrow(InvalidUsernameError);
  });
});
