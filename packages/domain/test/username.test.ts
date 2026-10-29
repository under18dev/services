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

/**
 * 理由を機械が読める形で返すこと（#312）。
 *
 * **画面が「使えません」としか言えないと、利用者は直しようがない。**
 * ところが理由を例外のメッセージから取り出させると、文面を変えた瞬間に
 * 読む側が静かに既定の文言へ落ちる。`reason` はそのための列挙で、
 * `apps/dashboard-worker/.../client/messages.ts` が
 * `Record<InvalidUsernameReason, string>` で受ける。
 */
describe("Username.reasonFor", () => {
  it("使える名前には null を返す", () => {
    expect(Username.reasonFor("u18_dev-01")).toBeNull();
    // 大文字と前後の空白は正規化されるので、使える側である。
    expect(Username.reasonFor("  TanaHiro  ")).toBeNull();
  });

  it.each([
    ["ab", "too_short"],
    ["a".repeat(33), "too_long"],
    ["taro!", "disallowed_characters"],
    ["-taro", "disallowed_characters"],
    ["taro_", "disallowed_characters"],
    ["Admin", "reserved"],
  ] as const)("%s は %s", (raw, reason) => {
    expect(Username.reasonFor(raw)).toBe(reason);
  });

  it("例外にも同じ理由が乗る", () => {
    // `create` / `tryCreate` / `reasonFor` が同じ判定を使っていること。
    // 3 つに書き写すと、登録と変更と画面でルールがずれる。
    expect(() => Username.create("Admin")).toThrow(
      expect.objectContaining({ reason: "reserved" }) as Error,
    );
    expect(Username.tryCreate("Admin")).toBeNull();
  });
});
