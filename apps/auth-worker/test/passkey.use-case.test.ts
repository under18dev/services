import { FixedClock, aSession, aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { GetSessionUseCase } from "../src/application/use-cases/get-session.use-case";
import { IssueSessionUseCase } from "../src/application/use-cases/issue-session.use-case";
import { PasskeyLoginOptionsUseCase } from "../src/application/use-cases/passkey-login-options.use-case";
import { PasskeyLoginVerifyUseCase } from "../src/application/use-cases/passkey-login-verify.use-case";
import { PasskeyRegisterOptionsUseCase } from "../src/application/use-cases/passkey-register-options.use-case";
import { PasskeyRegisterVerifyUseCase } from "../src/application/use-cases/passkey-register-verify.use-case";
import type { WebAuthnResponseJson } from "../src/application/ports/webauthn.port";
import { TokenLifetime } from "../src/domain/services/token-lifetime";
import { PepperedIpHasher, WebCryptoTokenGenerator } from "../src/infrastructure/crypto/web-crypto";
import {
  FakeHasher,
  InMemorySessionRepository,
  InMemoryUserRepository,
  RecordingAuditLogger,
  ImmediateSideEffectScheduler,
} from "./fakes";
import {
  FakeWebAuthnService,
  InMemoryPasskeyRepository,
  InMemoryWebAuthnChallengeRepository,
  aPasskey,
  aVerifiedRegistration,
} from "./fakes.passkey";

const NOW = new Date("2026-10-24T00:00:00.000Z");

function setup() {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const passkeys = new InMemoryPasskeyRepository();
  const challenges = new InMemoryWebAuthnChallengeRepository();
  const audit = new RecordingAuditLogger();
  const clock = new FixedClock(NOW);
  const hasher = new FakeHasher();
  const webauthn = new FakeWebAuthnService();

  const getSession = new GetSessionUseCase({
    sessions,
    users,
    hasher,
    clock,
    audit,
    sideEffects: new ImmediateSideEffectScheduler(),
  });
  const issueSession = new IssueSessionUseCase({
    users,
    sessions,
    hasher,
    ipHasher: new PepperedIpHasher("test-pepper"),
    tokens: new WebCryptoTokenGenerator(),
    clock,
    audit,
  });

  return {
    users,
    sessions,
    passkeys,
    challenges,
    audit,
    clock,
    webauthn,
    registerOptions: new PasskeyRegisterOptionsUseCase({
      getSession,
      users,
      passkeys,
      challenges,
      webauthn,
      clock,
    }),
    registerVerify: new PasskeyRegisterVerifyUseCase({
      getSession,
      passkeys,
      challenges,
      webauthn,
      clock,
      audit,
    }),
    loginOptions: new PasskeyLoginOptionsUseCase({ challenges, webauthn, clock }),
    loginVerify: new PasskeyLoginVerifyUseCase({
      issueSession,
      users,
      passkeys,
      challenges,
      webauthn,
      clock,
      audit,
    }),
  };
}

type Ctx = ReturnType<typeof setup>;

/** ログイン済みの利用者を作る。FakeHasher の約束でトークン = セッション ID。 */
function seedLoggedInUser(ctx: Ctx, overrides: Parameters<typeof aUser>[0] = {}) {
  const user = aUser(overrides);
  ctx.users.seed(user);
  const session = aSession({ userId: user.id });
  ctx.sessions.seed({ ...session, revokedAt: null });
  return { user, token: session.id };
}

const credential = (id: string): WebAuthnResponseJson => ({ id });

describe("PasskeyRegisterOptionsUseCase", () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it("Challenge を保存して options と一緒に返す", async () => {
    const { token, user } = seedLoggedInUser(ctx);

    const result = await ctx.registerOptions.execute({ sessionToken: token });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 保存した Challenge を後から消費できる（= DB に載っている）。
    const stored = await ctx.challenges.consume(result.value.challengeId, NOW);
    expect(stored?.userId).toBe(user.id);
    expect(stored?.purpose).toBe("registration");
    expect(stored?.expiresAt).toEqual(new Date(NOW.getTime() + TokenLifetime.webauthnChallengeMs));
  });

  it("登録済みの Credential を excludeCredentials として渡す", async () => {
    const { token, user } = seedLoggedInUser(ctx);
    ctx.passkeys.seed(aPasskey({ userId: user.id, credentialId: "already-mine" }));

    await ctx.registerOptions.execute({ sessionToken: token });

    expect(ctx.webauthn.registrationOptionsInputs[0]?.excludeCredentialIds).toEqual([
      "already-mine",
    ]);
  });

  it("未認証では Challenge を発行しない", async () => {
    // ここを通すと、他人のアカウントへ自分の認証器を足す入口になる。
    const result = await ctx.registerOptions.execute({ sessionToken: "not-a-real-token" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unauthenticated");
  });
});

describe("PasskeyRegisterVerifyUseCase", () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  /** options を 1 回発行して challengeId を得る。 */
  async function startRegistration(token: string): Promise<string> {
    const result = await ctx.registerOptions.execute({ sessionToken: token });
    if (!result.ok) throw new Error("failed to start registration");
    return result.value.challengeId;
  }

  it("検証に成功するとパスキーを登録する", async () => {
    const { token, user } = seedLoggedInUser(ctx);
    const challengeId = await startRegistration(token);
    ctx.webauthn.registrationResult = {
      verified: true,
      value: aVerifiedRegistration({ credentialId: "new-credential" }),
    };

    const result = await ctx.registerVerify.execute({
      sessionToken: token,
      challengeId,
      response: credential("new-credential"),
      label: "iPhone",
    });

    expect(result.ok).toBe(true);
    const stored = await ctx.passkeys.findByCredentialId("new-credential");
    expect(stored?.userId).toBe(user.id);
    expect(stored?.label).toBe("iPhone");
  });

  it("同じ Challenge を 2 回は使えない", async () => {
    const { token } = seedLoggedInUser(ctx);
    const challengeId = await startRegistration(token);
    ctx.webauthn.registrationResult = {
      verified: true,
      value: aVerifiedRegistration({ credentialId: "replayed" }),
    };

    const first = await ctx.registerVerify.execute({
      sessionToken: token,
      challengeId,
      response: credential("replayed"),
      label: null,
    });
    const second = await ctx.registerVerify.execute({
      sessionToken: token,
      challengeId,
      response: credential("replayed"),
      label: null,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("期限切れの Challenge を拒否する", async () => {
    const { token } = seedLoggedInUser(ctx);
    const challengeId = await startRegistration(token);
    ctx.webauthn.registrationResult = { verified: true, value: aVerifiedRegistration() };
    ctx.clock.advance(TokenLifetime.webauthnChallengeMs + 1);

    const result = await ctx.registerVerify.execute({
      sessionToken: token,
      challengeId,
      response: credential("cred-1"),
      label: null,
    });

    expect(result.ok).toBe(false);
    expect(await ctx.passkeys.findByCredentialId("cred-1")).toBeNull();
  });

  it("他人に発行された Challenge では登録できない", async () => {
    const victim = seedLoggedInUser(ctx);
    const attacker = seedLoggedInUser(ctx);
    const challengeId = await startRegistration(victim.token);
    ctx.webauthn.registrationResult = { verified: true, value: aVerifiedRegistration() };

    const result = await ctx.registerVerify.execute({
      sessionToken: attacker.token,
      challengeId,
      response: credential("cred-1"),
      label: null,
    });

    expect(result.ok).toBe(false);
  });

  it("ログイン用の Challenge を登録に流用できない", async () => {
    const { token } = seedLoggedInUser(ctx);
    const login = await ctx.loginOptions.execute();
    if (!login.ok) throw new Error("failed to start login");
    ctx.webauthn.registrationResult = { verified: true, value: aVerifiedRegistration() };

    const result = await ctx.registerVerify.execute({
      sessionToken: token,
      challengeId: login.value.challengeId,
      response: credential("cred-1"),
      label: null,
    });

    expect(result.ok).toBe(false);
  });

  it("他人に登録済みの Credential ID を奪えない", async () => {
    // 通せば、その認証器でのログインが攻撃者のアカウントに結びつく。
    const victim = seedLoggedInUser(ctx);
    ctx.passkeys.seed(aPasskey({ userId: victim.user.id, credentialId: "victim-credential" }));
    const attacker = seedLoggedInUser(ctx);
    const challengeId = await startRegistration(attacker.token);
    ctx.webauthn.registrationResult = {
      verified: true,
      value: aVerifiedRegistration({ credentialId: "victim-credential" }),
    };

    const result = await ctx.registerVerify.execute({
      sessionToken: attacker.token,
      challengeId,
      response: credential("victim-credential"),
      label: null,
    });

    expect(result.ok).toBe(false);
    // 被害者の行は書き換わっていない。
    const stored = await ctx.passkeys.findByCredentialId("victim-credential");
    expect(stored?.userId).toBe(victim.user.id);
  });

  it("WebAuthn の検証に失敗したら登録しない", async () => {
    const { token } = seedLoggedInUser(ctx);
    const challengeId = await startRegistration(token);
    ctx.webauthn.registrationResult = { verified: false, reason: "origin mismatch" };

    const result = await ctx.registerVerify.execute({
      sessionToken: token,
      challengeId,
      response: credential("cred-1"),
      label: null,
    });

    expect(result.ok).toBe(false);
    // 失敗理由は監査ログにだけ残し、応答には出さない。
    if (!result.ok) expect(result.error.message).not.toContain("origin");
    expect(ctx.audit.events.at(-1)?.reason).toBe("origin mismatch");
  });
});

describe("PasskeyLoginOptionsUseCase", () => {
  it("利用者を指定せずに Challenge を発行する", async () => {
    const ctx = setup();

    const result = await ctx.loginOptions.execute();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await ctx.challenges.consume(result.value.challengeId, NOW);
    // userId を持たせないことが、アカウント列挙を成立させない根拠（仕様書 9）。
    expect(stored?.userId).toBeNull();
    expect(stored?.purpose).toBe("authentication");
  });
});

describe("PasskeyLoginVerifyUseCase", () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  async function startLogin(): Promise<string> {
    const result = await ctx.loginOptions.execute();
    if (!result.ok) throw new Error("failed to start login");
    return result.value.challengeId;
  }

  /** 登録済みのパスキーを持つ利用者。 */
  function seedUserWithPasskey(overrides: Parameters<typeof aUser>[0] = {}, counter = 0) {
    const user = aUser(overrides);
    ctx.users.seed(user);
    ctx.passkeys.seed(
      aPasskey({ userId: user.id, credentialId: "registered-credential", counter }),
    );
    return user;
  }

  function acceptAuthentication(newCounter: number) {
    ctx.webauthn.authenticationResult = {
      verified: true,
      value: { credentialId: "registered-credential", newCounter, backedUp: true },
    };
  }

  it("検証に成功するとセッションを発行する", async () => {
    const user = seedUserWithPasskey();
    const challengeId = await startLogin();
    acceptAuthentication(1);

    const result = await ctx.loginVerify.execute({
      challengeId,
      response: credential("registered-credential"),
      userAgent: "vitest",
      ip: "203.0.113.1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.session.userId).toBe(user.id);
    expect(result.value.session.authMethod).toBe("passkey");
    expect(result.value.token.length).toBeGreaterThan(0);
    // 認証成功でサインカウンターが前進している。
    expect((await ctx.passkeys.findByCredentialId("registered-credential"))?.counter).toBe(1);
  });

  it("同じ Challenge で 2 回ログインできない", async () => {
    seedUserWithPasskey();
    const challengeId = await startLogin();
    acceptAuthentication(1);

    const first = await ctx.loginVerify.execute({
      challengeId,
      response: credential("registered-credential"),
      userAgent: null,
      ip: null,
    });
    acceptAuthentication(2);
    const second = await ctx.loginVerify.execute({
      challengeId,
      response: credential("registered-credential"),
      userAgent: null,
      ip: null,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("期限切れの Challenge を拒否する", async () => {
    seedUserWithPasskey();
    const challengeId = await startLogin();
    acceptAuthentication(1);
    ctx.clock.advance(TokenLifetime.webauthnChallengeMs + 1);

    const result = await ctx.loginVerify.execute({
      challengeId,
      response: credential("registered-credential"),
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
  });

  it("登録用の Challenge をログインに流用できない", async () => {
    const user = seedUserWithPasskey();
    const session = aSession({ userId: user.id });
    ctx.sessions.seed({ ...session, revokedAt: null });
    const registration = await ctx.registerOptions.execute({ sessionToken: session.id });
    if (!registration.ok) throw new Error("failed to start registration");
    acceptAuthentication(1);

    const result = await ctx.loginVerify.execute({
      challengeId: registration.value.challengeId,
      response: credential("registered-credential"),
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
  });

  it("サインカウンターの巻き戻りを拒否する", async () => {
    // 増えないカウンターは認証器の複製を示唆する（仕様書 9 WebAuthn）。
    seedUserWithPasskey({}, 10);
    const challengeId = await startLogin();
    acceptAuthentication(9);

    const result = await ctx.loginVerify.execute({
      challengeId,
      response: credential("registered-credential"),
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
    expect(ctx.audit.events.at(-1)?.reason).toBe("counter_regression");
    expect((await ctx.passkeys.findByCredentialId("registered-credential"))?.counter).toBe(10);
  });

  it("据え置きのカウンターも拒否する（0 以外）", async () => {
    seedUserWithPasskey({}, 5);
    const challengeId = await startLogin();
    acceptAuthentication(5);

    const result = await ctx.loginVerify.execute({
      challengeId,
      response: credential("registered-credential"),
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
  });

  it("カウンターを実装しない認証器（常に 0）はログインできる", async () => {
    // ここを塞ぐと、カウンター非対応のプラットフォーム認証器が全滅する。
    seedUserWithPasskey({}, 0);
    const challengeId = await startLogin();
    acceptAuthentication(0);

    const result = await ctx.loginVerify.execute({
      challengeId,
      response: credential("registered-credential"),
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(true);
  });

  it("停止中のユーザーはログインできない", async () => {
    seedUserWithPasskey({ status: "suspended" });
    const challengeId = await startLogin();
    acceptAuthentication(1);

    const result = await ctx.loginVerify.execute({
      challengeId,
      response: credential("registered-credential"),
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
    expect(ctx.audit.events.at(-1)?.reason).toBe("user_not_active");
  });

  it("論理削除されたユーザーは status が active のままでもログインできない", async () => {
    // deleted_at だけ立てて status を戻し忘れる運用は起こりうる。
    seedUserWithPasskey({ status: "active", deletedAt: NOW });
    const challengeId = await startLogin();
    acceptAuthentication(1);

    const result = await ctx.loginVerify.execute({
      challengeId,
      response: credential("registered-credential"),
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
  });

  it("アカウントの実在を応答から区別できない", async () => {
    // 未知の Credential・停止中ユーザー・署名の失敗がすべて同じ応答になること。
    // 違いが出ると、総当たりでアカウントの有無を確かめられる（仕様書 9）。
    seedUserWithPasskey({ status: "suspended" });
    const other = aUser();
    ctx.users.seed(other);
    ctx.passkeys.seed(aPasskey({ userId: other.id, credentialId: "healthy-credential" }));

    acceptAuthentication(1);
    const suspended = await ctx.loginVerify.execute({
      challengeId: await startLogin(),
      response: credential("registered-credential"),
      userAgent: null,
      ip: null,
    });

    const unknown = await ctx.loginVerify.execute({
      challengeId: await startLogin(),
      response: credential("never-registered"),
      userAgent: null,
      ip: null,
    });

    ctx.webauthn.authenticationResult = { verified: false, reason: "bad signature" };
    const badSignature = await ctx.loginVerify.execute({
      challengeId: await startLogin(),
      response: credential("healthy-credential"),
      userAgent: null,
      ip: null,
    });

    expect(suspended).toEqual(unknown);
    expect(suspended).toEqual(badSignature);
    expect(suspended.ok).toBe(false);
  });
});
