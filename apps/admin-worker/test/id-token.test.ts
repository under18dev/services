import { SignJWT, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { verifyIdToken } from "../src/oidc/id-token";
import { createFakeIdp } from "./fake-idp";

const ISSUER = "https://auth.example.test";
const AUDIENCE = "u18-admin";

describe("verifyIdToken", () => {
  it("正しい ID Token なら sub が取れる", async () => {
    const idp = await createFakeIdp(ISSUER);
    const idToken = await idp.signIdToken({ sub: "usr_abc", aud: AUDIENCE, nonce: "n1" });

    const result = await verifyIdToken({
      idToken,
      jwks: idp.jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
      nonce: "n1",
    });

    expect(result.sub).toBe("usr_abc");
  });

  it("nonce が違えば拒否する（リプレイ対策）", async () => {
    const idp = await createFakeIdp(ISSUER);
    const idToken = await idp.signIdToken({ sub: "usr_abc", aud: AUDIENCE, nonce: "n1" });

    await expect(
      verifyIdToken({ idToken, jwks: idp.jwks, issuer: ISSUER, audience: AUDIENCE, nonce: "n2" }),
    ).rejects.toThrow(/nonce/);
  });

  it("issuer が違えば拒否する（なりすまし対策）", async () => {
    const idp = await createFakeIdp(ISSUER);
    const idToken = await idp.signIdToken({ sub: "usr_abc", aud: AUDIENCE, nonce: "n1" });

    await expect(
      verifyIdToken({
        idToken,
        jwks: idp.jwks,
        issuer: "https://evil.example",
        audience: AUDIENCE,
        nonce: "n1",
      }),
    ).rejects.toThrow();
  });

  it("audience が自分宛てでなければ拒否する（他クライアント宛てトークンの横流し対策）", async () => {
    const idp = await createFakeIdp(ISSUER);
    const idToken = await idp.signIdToken({
      sub: "usr_abc",
      aud: "some-other-client",
      nonce: "n1",
    });

    await expect(
      verifyIdToken({ idToken, jwks: idp.jwks, issuer: ISSUER, audience: AUDIENCE, nonce: "n1" }),
    ).rejects.toThrow();
  });

  it("別の鍵で署名されていれば拒否する（鍵の差し替え対策）", async () => {
    const idp = await createFakeIdp(ISSUER);
    // 正規の jwks とは別に用意した鍵で署名する——攻撃者が自分の鍵で
    // 勝手に ID Token を作る形を模す。
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const forged = await new SignJWT({ nonce: "n1" })
      .setProtectedHeader({ alg: "ES256", kid: "test-key-1" })
      .setSubject("usr_abc")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyIdToken({
        idToken: forged,
        jwks: idp.jwks,
        issuer: ISSUER,
        audience: AUDIENCE,
        nonce: "n1",
      }),
    ).rejects.toThrow();
  });

  it("alg: none を名乗るトークンは拒否する（アルゴリズム混同対策）", async () => {
    const idp = await createFakeIdp(ISSUER);
    const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const payload = btoa(
      JSON.stringify({ sub: "usr_abc", iss: ISSUER, aud: AUDIENCE, nonce: "n1", exp: 9999999999 }),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const unsigned = `${header}.${payload}.`;

    await expect(
      verifyIdToken({
        idToken: unsigned,
        jwks: idp.jwks,
        issuer: ISSUER,
        audience: AUDIENCE,
        nonce: "n1",
      }),
    ).rejects.toThrow();
  });

  it("sub が無ければ拒否する", async () => {
    const idp = await createFakeIdp(ISSUER);
    const idToken = await idp.signRawClaims({
      iss: ISSUER,
      aud: AUDIENCE,
      nonce: "n1",
      // sub を意図的に欠く。
    });

    await expect(
      verifyIdToken({ idToken, jwks: idp.jwks, issuer: ISSUER, audience: AUDIENCE, nonce: "n1" }),
    ).rejects.toThrow(/sub/);
  });

  it("nonce が無ければ拒否する", async () => {
    const idp = await createFakeIdp(ISSUER);
    const idToken = await idp.signRawClaims({ sub: "usr_abc", iss: ISSUER, aud: AUDIENCE });

    await expect(
      verifyIdToken({ idToken, jwks: idp.jwks, issuer: ISSUER, audience: AUDIENCE, nonce: "n1" }),
    ).rejects.toThrow(/nonce/);
  });
});
