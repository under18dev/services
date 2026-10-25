import { describe, expect, it } from "vitest";
import {
  isSupportedCodeChallengeMethod,
  isValidCodeChallenge,
  isValidCodeVerifier,
} from "../src/domain/services/pkce";
import {
  TimingSafeComparator,
  WebCryptoPkceVerifier,
} from "../src/infrastructure/crypto/web-crypto";
import {
  loginUrlWithReturnTo,
  returnToForRequest,
  sanitizeReturnTo,
} from "../src/presentation/http/ui/return-to";

/**
 * PKCE の形式規則と S256 検証（#15 / #16 / RFC 7636）。
 *
 * 形の判定を Domain に置いているのは、交換時の定時間比較が常に 43 文字
 * 同士になるようにするため。入口で長さを固定しておかないと、比較が
 * 「長さが違う」で即 false を返す経路——比較時間から長さが漏れる経路——が
 * 残る（domain/services/pkce.ts）。
 */

describe("code_challenge の形式", () => {
  it("S256 の出力（base64url 43 文字）を受け付ける", () => {
    expect(isValidCodeChallenge("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
  });

  it.each([
    ["短い", "abc"],
    ["長い", "a".repeat(44)],
    ["base64url でない（+）", `${"a".repeat(42)}+`],
    ["base64url でない（/）", `${"a".repeat(42)}/`],
    ["パディング付き", `${"a".repeat(42)}=`],
    ["空", ""],
  ])("%s は拒否する", (_label, value) => {
    expect(isValidCodeChallenge(value)).toBe(false);
  });
});

describe("code_challenge_method", () => {
  it("S256 だけを受け付ける", () => {
    expect(isSupportedCodeChallengeMethod("S256")).toBe(true);
  });

  it("plain を受け付けない", () => {
    // plain は認可要求を観測できる相手がそのまま code_verifier を得る。
    expect(isSupportedCodeChallengeMethod("plain")).toBe(false);
  });

  it("省略を plain にも S256 にも補完しない", () => {
    // RFC 7636 の既定は plain だが、それを採ると上の理由で成立しない。
    // 黙って S256 とみなすのも RFC と食い違うので、明示を要求する。
    expect(isSupportedCodeChallengeMethod(null)).toBe(false);
    expect(isSupportedCodeChallengeMethod("")).toBe(false);
  });

  it("大文字小文字の揺れを許さない", () => {
    expect(isSupportedCodeChallengeMethod("s256")).toBe(false);
  });
});

describe("code_verifier の形式（RFC 7636 §4.1）", () => {
  it("43〜128 文字の unreserved を受け付ける", () => {
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(128))).toBe(true);
    expect(isValidCodeVerifier(`${"a".repeat(39)}-._~`)).toBe(true);
  });

  it.each([
    ["42 文字（エントロピー不足）", "a".repeat(42)],
    ["129 文字", "a".repeat(129)],
    ["unreserved 外（+）", `${"a".repeat(42)}+`],
    ["空白を含む", `${"a".repeat(42)} `],
    ["空", ""],
  ])("%s は拒否する", (_label, value) => {
    expect(isValidCodeVerifier(value)).toBe(false);
  });
});

describe("WebCryptoPkceVerifier", () => {
  const verifier = new WebCryptoPkceVerifier(new TimingSafeComparator());

  it("RFC 7636 附録 B のベクタと一致する", async () => {
    // 仕様が例示している値をそのまま使う。自前で作った組で検証すると、
    // 実装とテストが同じ誤りを共有していても気付けない。
    await expect(
      verifier.verifyS256(
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      ),
    ).resolves.toBe(true);
  });

  it("1 文字違う code_verifier を拒否する", async () => {
    await expect(
      verifier.verifyS256(
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXl",
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      ),
    ).resolves.toBe(false);
  });

  it("challenge をそのまま verifier として渡しても通らない（plain 相当）", async () => {
    const value = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    await expect(verifier.verifyS256(value, value)).resolves.toBe(false);
  });
});

/**
 * ログイン後の戻り先（#15）。
 *
 * ここを広げると、u18 のログイン画面から外部サイトへ飛ばすオープン
 * リダイレクトになる。「相対パスなら安全」が成り立たないことを固定する。
 */
describe("sanitizeReturnTo", () => {
  it("認可要求のパスを通す", () => {
    expect(sanitizeReturnTo("/oauth/authorize?client_id=x")).toBe("/oauth/authorize?client_id=x");
    expect(sanitizeReturnTo("/oauth/authorize")).toBe("/oauth/authorize");
  });

  it("アカウント管理画面のパスを通す（未ログインで弾かれた画面へ戻すため）", () => {
    expect(sanitizeReturnTo("/account")).toBe("/account");
    expect(sanitizeReturnTo("/account/sessions")).toBe("/account/sessions");
    expect(sanitizeReturnTo("/account/nfc")).toBe("/account/nfc");
    expect(sanitizeReturnTo("/account?tab=x")).toBe("/account?tab=x");
  });

  it.each([
    ["絶対 URL", "https://evil.test/"],
    ["プロトコル相対", "//evil.test/"],
    ["バックスラッシュ", "/\\evil.test"],
    ["別のパス", "/login"],
    ["前方一致の偽装", "/oauth/authorize.evil.test"],
    ["接頭辞の偽装（アカウント）", "/accountevil.test"],
    ["接頭辞の偽装（区切り無し）", "/account.evil.test"],
    ["パストラバーサル（アカウント）", "/account/../../evil"],
    // 綴りを探すだけでは足りない。符号化された形も正規化すると /evil になる。
    ["符号化したパストラバーサル", "/account/%2e%2e/%2e%2e/evil"],
    ["大文字で符号化", "/account/%2E%2E/evil"],
    ["符号化と生の混在", "/account/.%2e/evil"],
    ["パストラバーサル", "/oauth/authorize/../../evil"],
    ["改行（ヘッダ分割）", "/oauth/authorize?a=1\r\nLocation: https://evil.test"],
    ["スキーム", "javascript:alert(1)"],
    ["空", ""],
    ["null", null],
  ])("%s は捨てる", (_label, value) => {
    expect(sanitizeReturnTo(value)).toBeNull();
  });
});

describe("returnToForRequest", () => {
  it("ホスト部を落としてパスとクエリだけにする", () => {
    expect(returnToForRequest("http://localhost:8787/oauth/authorize?client_id=x")).toBe(
      "/oauth/authorize?client_id=x",
    );
  });

  it("認可要求以外の URL からは戻り先を作らない", () => {
    expect(returnToForRequest("http://localhost:8787/oauth/consent")).toBeNull();
  });
});

describe("loginUrlWithReturnTo", () => {
  it("戻り先を符号化して載せる", () => {
    expect(loginUrlWithReturnTo("/oauth/authorize?a=b&c=d")).toBe(
      "/login?return_to=%2Foauth%2Fauthorize%3Fa%3Db%26c%3Dd",
    );
  });

  it("戻り先が無ければ素の /login", () => {
    expect(loginUrlWithReturnTo(null)).toBe("/login");
  });
});
