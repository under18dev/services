import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCsrfCookie,
  csrfCookieName,
  generateCsrfToken,
  isTrustedOrigin,
  isValidCsrf,
} from "../src/csrf";

/**
 * form POST の CSRF 対策（仕様書 9 CSRF）。
 *
 * **auth-worker と dashboard-worker が同じこのモジュールを使う。** 画面側の
 * テストは「正しい手順なら通る」ことを見ているが、ここでは**落ちるべきものが
 * 落ちること**を 1 つずつ見る。片方の Worker の画面テストだけに頼ると、
 * 判定の抜けは「まだその経路を書いていないだけ」で隠れる。
 */

const BASE = {
  originAllowed: true,
  expected: "token-value",
  submitted: "token-value",
  event: "csrf.rejected",
  path: "/account/example",
  origin: "https://auth.under18.dev",
  secFetchSite: "same-origin",
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

function captureWarn(): () => readonly Record<string, unknown>[] {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () =>
    warn.mock.calls.map(([first]) => JSON.parse(String(first)) as Record<string, unknown>);
}

describe("Cookie の名前と属性", () => {
  it("本番は __Host- 接頭辞", () => {
    expect(csrfCookieName("production")).toBe("__Host-u18_csrf");
  });

  it("development は接頭辞なし（http://localhost で Secure を付けられない）", () => {
    expect(csrfCookieName("development")).toBe("u18_csrf");
  });

  it("本番の Cookie は HttpOnly / Secure / SameSite=Lax / Path=/", () => {
    const cookie = buildCsrfCookie("production", "abc");

    expect(cookie).toContain("__Host-u18_csrf=abc");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("development では Secure を付けない", () => {
    // **付けると localhost で Cookie が保存されず、double-submit が
    // 必ず no_cookie で落ちる。** 開発者には「CSRF が壊れている」と見える。
    expect(buildCsrfCookie("development", "abc")).not.toContain("Secure");
  });
});

describe("トークン", () => {
  it("32 バイトの base64url（43 文字・パディング無し）", () => {
    const token = generateCsrfToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("呼ぶたびに違う値になる", () => {
    const tokens = new Set(Array.from({ length: 32 }, () => generateCsrfToken()));

    expect(tokens.size).toBe(32);
  });
});

describe("Origin の判定", () => {
  it("同じオリジンなら通る", () => {
    expect(
      isTrustedOrigin("https://auth.under18.dev", "same-origin", "https://auth.under18.dev"),
    ).toBe(true);
  });

  it("末尾スラッシュと大文字小文字の揺れを吸収する", () => {
    // `ISSUER` は OIDC の `iss` として使う値。厳密一致にすると、
    // 設定が 1 文字違うだけで更新系が全件 403 になる。
    expect(
      isTrustedOrigin("https://AUTH.under18.dev", undefined, "https://auth.under18.dev/"),
    ).toBe(true);
  });

  it("別のオリジンは落ちる", () => {
    expect(isTrustedOrigin("https://evil.example", undefined, "https://auth.under18.dev")).toBe(
      false,
    );
  });

  it("Origin が無ければ落ちる（fail-closed）", () => {
    expect(isTrustedOrigin(undefined, "same-origin", "https://auth.under18.dev")).toBe(false);
  });

  it("URL として読めない Origin は落ちる", () => {
    expect(isTrustedOrigin("not a url", undefined, "https://auth.under18.dev")).toBe(false);
  });

  it("Origin: null でも Sec-Fetch-Site: same-origin なら通る", () => {
    // #226 で本番のログインが全滅した形。referrer policy が参照元を落とすと
    // ナビゲーション要求の Origin も null になる。
    expect(isTrustedOrigin("null", "same-origin", "https://auth.under18.dev")).toBe(true);
  });

  it("Origin: null で Sec-Fetch-Site が cross-site なら落ちる", () => {
    expect(isTrustedOrigin("null", "cross-site", "https://auth.under18.dev")).toBe(false);
  });

  it("Origin: null で Sec-Fetch-Site が無ければ落ちる", () => {
    // 救済はブラウザが「自分のオリジンから出た」と言っているときだけ。
    // ヘッダごと落とせる相手に通してはいけない。
    expect(isTrustedOrigin("null", undefined, "https://auth.under18.dev")).toBe(false);
  });
});

describe("double-submit の判定", () => {
  it("Origin とトークンが揃っていれば通る", () => {
    const read = captureWarn();

    expect(isValidCsrf(BASE)).toBe(true);
    expect(read()).toEqual([]);
  });

  it.each([
    ["origin", { ...BASE, originAllowed: false }],
    ["no_cookie", { ...BASE, expected: undefined }],
    ["no_cookie", { ...BASE, expected: "" }],
    ["no_token", { ...BASE, submitted: undefined }],
    ["no_token", { ...BASE, submitted: "" }],
    ["token_mismatch", { ...BASE, submitted: "different-val" }],
  ])("%s で落ちて、理由をログに出す", (reason, check) => {
    const read = captureWarn();

    expect(isValidCsrf(check)).toBe(false);
    expect(read()).toHaveLength(1);
    expect(read()[0]).toMatchObject({ event: "csrf.rejected", reason, path: "/account/example" });
  });

  it("長さが同じでも値が違えば落ちる", () => {
    captureWarn();

    expect(isValidCsrf({ ...BASE, submitted: "token-valuf" })).toBe(false);
  });

  it("Origin は他のどれよりも先に見る", () => {
    // Origin が落ちているときに「トークンが無い」と答えると、
    // クロスサイトの相手に「Cookie は届いていない」と教えることになる。
    const read = captureWarn();

    isValidCsrf({ ...BASE, originAllowed: false, expected: undefined, submitted: undefined });

    expect(read()[0]).toMatchObject({ reason: "origin" });
  });

  it("トークンの値そのものはログに出さない", () => {
    // ログを読める範囲が、そのまま CSRF を抜ける範囲になる。
    const read = captureWarn();

    isValidCsrf({ ...BASE, expected: "secret-cookie-value", submitted: "secret-form-value" });

    const line = JSON.stringify(read()[0]);
    expect(line).not.toContain("secret-cookie-value");
    expect(line).not.toContain("secret-form-value");
    // 長さと有無は出す。切り分けにはそれで足りる。
    expect(read()[0]).toMatchObject({ hasCookie: true, submittedLength: 17 });
  });

  it("調査に要るヘッダを残す", () => {
    // 本番で「どのメールアドレスを入れても操作を受け付けられない」という
    // 報告が出たとき、`Origin: null` だと分かるまで wrangler tail で
    // 生のヘッダを見るしかなかった（#226）。
    const read = captureWarn();

    isValidCsrf({ ...BASE, originAllowed: false, origin: "null", secFetchSite: "cross-site" });

    expect(read()[0]).toMatchObject({ origin: "null", secFetchSite: "cross-site" });
  });
});
