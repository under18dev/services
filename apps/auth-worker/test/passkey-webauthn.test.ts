import { beforeAll, describe, expect, it } from "vitest";
import { SimpleWebAuthnService } from "../src/infrastructure/webauthn/simplewebauthn.service";
import { TestAuthenticator } from "./fakes.passkey";
import type { WebAuthnResponseJson } from "../src/application/ports/webauthn.port";

/**
 * WebAuthn Port の実装を、本物の認証器（P-256 の鍵で実際に署名する）に対して検証する。
 *
 * ここが仕様書 9「Origin / RP ID / Challenge / User Verification を検証する」の
 * 受け入れテストになる。Fake で置き換えると「設定値を渡し忘れていても通る」ので、
 * この 1 本だけは実物のライブラリを通す。
 */

const RP_ID = "localhost";
const RP_NAME = "u18 Identity";
const ORIGIN = "http://localhost:8787";
const CHALLENGE = "Q2hhbGxlbmdlRm9yVGVzdGluZw";

const service = new SimpleWebAuthnService({ rpId: RP_ID, rpName: RP_NAME, origin: ORIGIN });

let authenticator: TestAuthenticator;

beforeAll(async () => {
  authenticator = await TestAuthenticator.create();
});

async function register(
  overrides: Partial<Parameters<TestAuthenticator["attest"]>[0]> = {},
  expectedChallenge = CHALLENGE,
) {
  const response = await authenticator.attest({
    challenge: CHALLENGE,
    origin: ORIGIN,
    rpId: RP_ID,
    ...overrides,
  });
  return service.verifyRegistration({
    response: response as WebAuthnResponseJson,
    expectedChallenge,
  });
}

describe("SimpleWebAuthnService: 登録の検証", () => {
  it("正しい Origin / RP ID / Challenge なら公開鍵を取り出せる", async () => {
    const result = await register();

    expect(result.verified).toBe(true);
    if (!result.verified) return;
    expect(result.value.credentialId).toBe(authenticator.credentialId);
    expect(result.value.publicKey.length).toBeGreaterThan(0);
    expect(result.value.counter).toBe(0);
  });

  it("別 Origin からの登録を拒否する", async () => {
    // Origin を見ないと、攻撃者のサイトが踏み台にできる。
    const result = await register({ origin: "https://evil.example" });
    expect(result.verified).toBe(false);
  });

  it("別 RP ID の認証器データを拒否する", async () => {
    const result = await register({ rpId: "evil.example" });
    expect(result.verified).toBe(false);
  });

  it("発行していない Challenge を拒否する", async () => {
    const result = await register({}, "c29tZS1vdGhlci1jaGFsbGVuZ2U");
    expect(result.verified).toBe(false);
  });

  it("User Verification されていない登録を拒否する", async () => {
    // UV なしを許すと、端末を拾った第三者がパスキーを足せる。
    const result = await register({ userVerified: false });
    expect(result.verified).toBe(false);
  });
});

describe("SimpleWebAuthnService: 認証の検証", () => {
  /** 登録済みパスキーとして Port へ渡す形。 */
  async function registeredCredential() {
    const result = await register();
    if (!result.verified) throw new Error("registration fixture failed");
    return {
      credentialId: result.value.credentialId,
      publicKey: result.value.publicKey,
      counter: result.value.counter,
      transports: result.value.transports,
    };
  }

  async function authenticate(
    overrides: Partial<Parameters<TestAuthenticator["assert"]>[0]> = {},
    credentialOverrides: Partial<Awaited<ReturnType<typeof registeredCredential>>> = {},
  ) {
    const response = await authenticator.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      counter: 1,
      ...overrides,
    });
    return service.verifyAuthentication({
      response: response as WebAuthnResponseJson,
      expectedChallenge: CHALLENGE,
      credential: { ...(await registeredCredential()), ...credentialOverrides },
    });
  }

  it("正しい署名なら検証を通し、新しいカウンターを返す", async () => {
    const result = await authenticate({ counter: 7 });

    expect(result.verified).toBe(true);
    if (!result.verified) return;
    expect(result.value.newCounter).toBe(7);
    expect(result.value.credentialId).toBe(authenticator.credentialId);
  });

  it("別 Origin からの認証を拒否する", async () => {
    const result = await authenticate({ origin: "https://evil.example" });
    expect(result.verified).toBe(false);
  });

  it("別 RP ID の認証器データを拒否する", async () => {
    const result = await authenticate({ rpId: "evil.example" });
    expect(result.verified).toBe(false);
  });

  it("User Verification されていない認証を拒否する", async () => {
    const result = await authenticate({ userVerified: false });
    expect(result.verified).toBe(false);
  });

  it("別の鍵で署名された応答を拒否する", async () => {
    const other = await TestAuthenticator.create();
    const credential = await registeredCredential();
    const response = await other.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      counter: 1,
    });

    const result = await service.verifyAuthentication({
      response: response as WebAuthnResponseJson,
      expectedChallenge: CHALLENGE,
      // Credential ID だけ合わせても、公開鍵が違えば署名は合わない。
      credential: { ...credential, credentialId: other.credentialId },
    });

    expect(result.verified).toBe(false);
  });

  it("巻き戻ったサインカウンターを拒否する", async () => {
    // 保存値より小さいカウンターは Credential の複製を示唆する（仕様書 9）。
    const result = await authenticate({ counter: 3 }, { counter: 10 });
    expect(result.verified).toBe(false);
  });
});

/**
 * 本番構成（#33）では RP ID が issuer のホストより広い。
 *
 * `RP_ID` は `under18.dev`（ゾーン）で、`WEBAUTHN_ORIGIN` は
 * `https://auth.under18.dev`（ホスト）。RP ID を広く取ったのは、Credential に
 * 焼き付く RP ID を後から変えられない以上、IdP のホスト名を動かす余地を
 * 残すためだった。
 *
 * **その代償をここで払っている。** RP ID がゾーンなので、`*.under18.dev` の
 * どのページでも `rpId=under18.dev` で assertion を取得できてしまう。
 * RP ID の検査はそれを通す —— 通すのが正しい。止めているのは origin の
 * 厳密一致だけで、つまり **origin 検証はこの構成では「念のため」ではなく、
 * apex RP ID を安全にしている唯一の仕組み**である。
 *
 * 以下のテストはその 1 点を固定するために置いている。無関係なドメイン
 * （evil.example）が落ちることは上の describe が既に確かめているが、
 * それでは「兄弟サブドメインも落ちる」ことの証明にならない。RP ID が
 * 一致したうえで origin だけが違う、という状況を作る必要がある。
 *
 * ここが落ちるようになったら、`expectedOrigin` が配列化されたか
 * `endsWith` などの部分一致に緩められた可能性が高い。直す対象はこの
 * テストではなく、緩めた側である。
 */
describe("本番構成: apex RP ID を origin 検証が支えている (#33)", () => {
  const PROD_RP_ID = "under18.dev";
  const PROD_ORIGIN = "https://auth.under18.dev";
  /** RP ID の配下だが、IdP ではないホスト。 */
  const SIBLING_ORIGIN = "https://evil.under18.dev";

  const prodService = new SimpleWebAuthnService({
    rpId: PROD_RP_ID,
    rpName: RP_NAME,
    origin: PROD_ORIGIN,
  });

  it("兄弟サブドメインで取得した登録を拒否する", async () => {
    const response = await authenticator.attest({
      challenge: CHALLENGE,
      // RP ID はゾーンのまま。認証器から見れば完全に正当な値で、
      // rpIdHash の検査は通過する。
      rpId: PROD_RP_ID,
      origin: SIBLING_ORIGIN,
    });

    const result = await prodService.verifyRegistration({
      response: response as WebAuthnResponseJson,
      expectedChallenge: CHALLENGE,
    });

    expect(result.verified).toBe(false);
  });

  it("兄弟サブドメインで取得した認証を拒否する", async () => {
    const registration = await prodService.verifyRegistration({
      response: (await authenticator.attest({
        challenge: CHALLENGE,
        rpId: PROD_RP_ID,
        origin: PROD_ORIGIN,
      })) as WebAuthnResponseJson,
      expectedChallenge: CHALLENGE,
    });
    if (!registration.verified) throw new Error("registration fixture failed");

    const response = await authenticator.assert({
      challenge: CHALLENGE,
      rpId: PROD_RP_ID,
      origin: SIBLING_ORIGIN,
      counter: 1,
    });

    const result = await prodService.verifyAuthentication({
      response: response as WebAuthnResponseJson,
      expectedChallenge: CHALLENGE,
      credential: {
        credentialId: registration.value.credentialId,
        publicKey: registration.value.publicKey,
        counter: registration.value.counter,
        transports: registration.value.transports,
      },
    });

    expect(result.verified).toBe(false);
  });

  it("正規の issuer ホストからなら通る（上の 2 件が origin 以外の理由で落ちていないこと）", async () => {
    // 対照群。これが落ちていると、上の 2 件は「origin を見ているから」
    // ではなく別の理由で失敗していることになり、テストの意味が消える。
    const response = await authenticator.attest({
      challenge: CHALLENGE,
      rpId: PROD_RP_ID,
      origin: PROD_ORIGIN,
    });

    const result = await prodService.verifyRegistration({
      response: response as WebAuthnResponseJson,
      expectedChallenge: CHALLENGE,
    });

    expect(result.verified).toBe(true);
  });
});
