import { describe, expect, it } from "vitest";
import { deriveCodeChallenge, generateCodeVerifier, generateOpaqueValue } from "../src/oidc/pkce";

describe("PKCE", () => {
  it("code_verifier は RFC 7636 §4.1 の文字集合だけを使う", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it("毎回違う値になる", () => {
    const values = new Set(Array.from({ length: 50 }, () => generateCodeVerifier()));
    expect(values.size).toBe(50);
  });

  it("code_challenge は S256 を既知のベクタで確かめる", async () => {
    // RFC 7636 Appendix B の既知ベクタ。
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await deriveCodeChallenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("code_challenge は base64url（パディング無し）", async () => {
    const challenge = await deriveCodeChallenge(generateCodeVerifier());
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it("opaque な値（state / nonce）は毎回違う", () => {
    const values = new Set(Array.from({ length: 50 }, () => generateOpaqueValue()));
    expect(values.size).toBe(50);
  });
});
