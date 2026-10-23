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
});
