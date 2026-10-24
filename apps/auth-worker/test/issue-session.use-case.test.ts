import { FixedClock, aSession, aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { IssueSessionUseCase } from "../src/application/use-cases/issue-session.use-case";
import { GetSessionUseCase } from "../src/application/use-cases/get-session.use-case";
import { LogoutUseCase } from "../src/application/use-cases/logout.use-case";
import { PepperedIpHasher, WebCryptoTokenGenerator } from "../src/infrastructure/crypto/web-crypto";
import {
  FakeHasher,
  InMemorySessionRepository,
  InMemoryUserRepository,
  RecordingAuditLogger,
} from "./fakes";
import { InMemoryAuthorizationCodeRepository } from "./fakes.oauth";

const NOW = new Date("2026-10-24T00:00:00.000Z");

function setup() {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const audit = new RecordingAuditLogger();
  const clock = new FixedClock(NOW);
  const hasher = new FakeHasher();
  // ログアウトは未交換の認可コードも落とす（#15）。
  const codes = new InMemoryAuthorizationCodeRepository();

  return {
    users,
    sessions,
    codes,
    audit,
    clock,
    issueSession: new IssueSessionUseCase({
      users,
      sessions,
      hasher,
      ipHasher: new PepperedIpHasher("test-pepper"),
      tokens: new WebCryptoTokenGenerator(),
      clock,
      audit,
    }),
    getSession: new GetSessionUseCase({ sessions, users, hasher, clock, audit }),
    logout: new LogoutUseCase({ sessions, codes, hasher, clock, audit }),
  };
}

describe("IssueSessionUseCase", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("有効なユーザーにセッションと平文トークンを返す", async () => {
    const user = ctx.users.seed(aUser());

    const result = await ctx.issueSession.execute({
      userId: user.id,
      authMethod: "passkey",
      userAgent: "vitest",
      ip: "203.0.113.1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.session.userId).toBe(user.id);
    expect(result.value.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 バイトの base64url
  });

  it("有効期限は 12 時間（仕様書 5.3）", async () => {
    const user = ctx.users.seed(aUser());

    const result = await ctx.issueSession.execute({
      userId: user.id,
      authMethod: "email_otp",
      userAgent: null,
      ip: null,
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.session.expiresAt.toISOString()).toBe("2026-10-24T12:00:00.000Z");
  });

  it("生の IP ではなくハッシュを保存する", async () => {
    const user = ctx.users.seed(aUser());

    const result = await ctx.issueSession.execute({
      userId: user.id,
      authMethod: "passkey",
      userAgent: null,
      ip: "203.0.113.1",
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.session.ipHash).not.toBeNull();
    expect(result.value.session.ipHash).not.toContain("203.0.113");
  });

  it("発行したトークンでそのままセッションを引ける", async () => {
    const user = ctx.users.seed(aUser());
    const issued = await ctx.issueSession.execute({
      userId: user.id,
      authMethod: "passkey",
      userAgent: null,
      ip: null,
    });
    if (!issued.ok) throw new Error("expected success");

    const resolved = await ctx.getSession.execute({ sessionToken: issued.value.token });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value?.userId).toBe(user.id);
  });

  it("毎回異なるトークンを発行する", async () => {
    const user = ctx.users.seed(aUser());
    const tokens = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const r = await ctx.issueSession.execute({
        userId: user.id,
        authMethod: "passkey",
        userAgent: null,
        ip: null,
      });
      if (r.ok) tokens.add(r.value.token);
    }
    expect(tokens.size).toBe(20);
  });

  it("停止中ユーザーには発行しない", async () => {
    const user = ctx.users.seed(aUser({ status: "suspended" }));

    const result = await ctx.issueSession.execute({
      userId: user.id,
      authMethod: "passkey",
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("論理削除済みユーザーには発行しない", async () => {
    const user = ctx.users.seed(aUser({ status: "active", deletedAt: NOW }));

    const result = await ctx.issueSession.execute({
      userId: user.id,
      authMethod: "passkey",
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
  });

  it("管理者にはメール OTP でセッションを発行しない（仕様書 §14.1 決定 8）", async () => {
    // メール OTP はメールボックスの支配権がそのままアカウントの支配権になる。
    // 管理権限に対してはその取引が割に合わないので、#40 で Passkey 必須と決めた。
    const admin = ctx.users.seed(aUser({ isAdmin: true }));

    const result = await ctx.issueSession.execute({
      userId: admin.id,
      authMethod: "email_otp",
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    // セッション行そのものが生まれていないこと。「発行したが使えない」では、
    // 後から管理操作が増えたときにその入口が拾ってしまう。
    expect(await ctx.sessions.listByUserId(admin.id)).toEqual([]);
    expect(
      ctx.audit.events.some(
        (e) => e.event === "session.issue" && e.reason === "admin_requires_passkey",
      ),
    ).toBe(true);
  });

  it("管理者でも Passkey なら発行する", async () => {
    const admin = ctx.users.seed(aUser({ isAdmin: true }));

    const result = await ctx.issueSession.execute({
      userId: admin.id,
      authMethod: "passkey",
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.session.authMethod).toBe("passkey");
  });

  it("一般利用者のメール OTP は塞がない（決定 2）", async () => {
    // 決定 8 を広げすぎると、Passkey を持たない利用者が締め出される。
    const user = ctx.users.seed(aUser({ isAdmin: false }));

    const result = await ctx.issueSession.execute({
      userId: user.id,
      authMethod: "email_otp",
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(true);
  });

  it("存在しないユーザーには発行しない", async () => {
    const result = await ctx.issueSession.execute({
      userId: "usr_nope",
      authMethod: "passkey",
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("LogoutUseCase", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  async function signIn() {
    const user = ctx.users.seed(aUser());
    const issued = await ctx.issueSession.execute({
      userId: user.id,
      authMethod: "passkey",
      userAgent: null,
      ip: null,
    });
    if (!issued.ok) throw new Error("expected success");
    return { user, token: issued.value.token, sessionId: issued.value.session.id };
  }

  it("セッションを失効させる", async () => {
    const { token, sessionId } = await signIn();

    const result = await ctx.logout.execute({ sessionToken: token, allDevices: false });

    expect(result).toEqual({ ok: true, value: { revokedCount: 1 } });
    expect((await ctx.sessions.findById(sessionId))?.isRevoked).toBe(true);
  });

  it("失効後は同じトークンで認証できない", async () => {
    const { token } = await signIn();
    await ctx.logout.execute({ sessionToken: token, allDevices: false });

    const resolved = await ctx.getSession.execute({ sessionToken: token });

    expect(resolved).toEqual({ ok: true, value: null });
  });

  it("無効なトークンでも成功を返す（冪等）", async () => {
    // 「そのセッションは無かった」と返すと、トークンの実在を探れてしまう。
    const result = await ctx.logout.execute({
      sessionToken: "never-existed",
      allDevices: false,
    });

    expect(result).toEqual({ ok: true, value: { revokedCount: 0 } });
  });

  it("二重ログアウトでも失敗しない", async () => {
    const { token } = await signIn();
    await ctx.logout.execute({ sessionToken: token, allDevices: false });

    const second = await ctx.logout.execute({ sessionToken: token, allDevices: false });

    expect(second.ok).toBe(true);
  });

  it("allDevices で同じユーザーの全セッションを失効させる", async () => {
    const { user, token } = await signIn();
    ctx.sessions.seed({ ...aSession({ userId: user.id }), revokedAt: null });
    ctx.sessions.seed({ ...aSession({ userId: user.id }), revokedAt: null });

    const result = await ctx.logout.execute({ sessionToken: token, allDevices: true });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.revokedCount).toBe(3);
  });

  it("失効済みトークンでは allDevices が効かない", async () => {
    // 盗まれたトークンを利用者が失効させた後も、攻撃者が allDevices で
    // 永久に蹴り出し続けられては失効機能の意味が無い。
    // Origin 検証は防御にならない（ブラウザ外からは任意に付けられる）。
    const { user, token, sessionId } = await signIn();
    const other = aSession({ userId: user.id });
    ctx.sessions.seed({ ...other, revokedAt: null });
    await ctx.sessions.revoke(sessionId, NOW);

    const result = await ctx.logout.execute({ sessionToken: token, allDevices: true });

    expect(result).toEqual({ ok: true, value: { revokedCount: 0 } });
    // 他のセッションは生きたまま。
    expect((await ctx.sessions.findById(other.id))?.isRevoked).toBe(false);
  });

  it("期限切れトークンでも allDevices が効かない", async () => {
    const { user, token } = await signIn();
    const other = aSession({ userId: user.id });
    ctx.sessions.seed({ ...other, revokedAt: null });
    ctx.clock.advance(13 * 60 * 60 * 1000); // 12 時間の上限を超える

    const result = await ctx.logout.execute({ sessionToken: token, allDevices: true });

    expect(result).toEqual({ ok: true, value: { revokedCount: 0 } });
    expect((await ctx.sessions.findById(other.id))?.isRevoked).toBe(false);
  });

  it("allDevices でも他人のセッションは失効させない", async () => {
    const { token } = await signIn();
    const stranger = ctx.users.seed(aUser());
    const strangerSession = aSession({ userId: stranger.id });
    ctx.sessions.seed({ ...strangerSession, revokedAt: null });

    await ctx.logout.execute({ sessionToken: token, allDevices: true });

    expect((await ctx.sessions.findById(strangerSession.id))?.isRevoked).toBe(false);
  });
});
