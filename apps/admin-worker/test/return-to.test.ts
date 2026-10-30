import { describe, expect, it } from "vitest";
import { sanitizeReturnTo } from "../src/oidc/return-to";

/**
 * auth-worker の `return-to.ts` と同じ脅威クラス（#226 系のオープン
 * リダイレクト）に同じ形で答えることを確かめる。実測の符号化パターンも
 * あちらから引いている。
 */
describe("sanitizeReturnTo", () => {
  it("相対パスを通す", () => {
    expect(sanitizeReturnTo("/users")).toBe("/users");
    expect(sanitizeReturnTo("/users?foo=bar")).toBe("/users?foo=bar");
  });

  it("未指定・空文字は既定の戻り先", () => {
    expect(sanitizeReturnTo(null)).toBe("/");
    expect(sanitizeReturnTo(undefined)).toBe("/");
    expect(sanitizeReturnTo("")).toBe("/");
  });

  it("絶対 URL を拒否する", () => {
    expect(sanitizeReturnTo("https://evil.example/")).toBe("/");
    expect(sanitizeReturnTo("http://evil.example/")).toBe("/");
  });

  it("プロトコル相対 URL を拒否する（// は別オリジンになりうる）", () => {
    expect(sanitizeReturnTo("//evil.example/")).toBe("/");
  });

  it("バックスラッシュ始まりを拒否する（ブラウザによって別オリジンになる）", () => {
    expect(sanitizeReturnTo("/\\evil.example")).toBe("/");
  });

  it("改行を含む値を拒否する（ヘッダ分割対策）", () => {
    expect(sanitizeReturnTo("/users\r\nSet-Cookie: x=1")).toBe("/");
  });

  it("`..` を正規化してから返す（符号化された形も同じ結果になる）", () => {
    // admin-worker には auth-worker のような「許可する接頭辞のリスト」が
    // 無い——この Worker の中で完結する相対パスなら、正規化した先が
    // どこであっても同一オリジンの中である。正規化すること自体の価値は、
    // 「どちらの綴りでも同じ扱いになる」こと（符号化で素通りする経路を
    // 残さない）。
    expect(sanitizeReturnTo("/users/../../evil")).toBe("/evil");
    expect(sanitizeReturnTo("/users/%2e%2e/%2e%2e/evil")).toBe("/evil");
  });
});
