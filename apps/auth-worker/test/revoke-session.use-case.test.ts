import { FixedClock, aSession, aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { GetSessionUseCase } from "../src/application/use-cases/get-session.use-case";
import { ListSessionsUseCase } from "../src/application/use-cases/list-sessions.use-case";
import { RevokeSessionUseCase } from "../src/application/use-cases/revoke-session.use-case";
import {
  FakeHasher,
  InMemorySessionRepository,
  InMemoryUserRepository,
  RecordingAuditLogger,
} from "./fakes";

const NOW = new Date("2026-10-24T00:00:00.000Z");

function setup() {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const audit = new RecordingAuditLogger();
  const clock = new FixedClock(NOW);
  const hasher = new FakeHasher();

  const getSession = new GetSessionUseCase({ sessions, users, hasher, clock, audit });
  return {
    users,
    sessions,
    audit,
    clock,
    getSession,
    listSessions: new ListSessionsUseCase({ getSession, sessions, clock }),
    revokeSession: new RevokeSessionUseCase({ getSession, sessions, clock, audit }),
  };
}

/** 有効なユーザーとセッションを作り、そのセッショントークンを返す。 */
function seedLoggedInUser(ctx: ReturnType<typeof setup>, overrides: { userId?: string } = {}) {
  const user = aUser(overrides.userId ? { id: overrides.userId } : {});
  ctx.users.seed(user);
  const session = aSession({ userId: user.id });
  ctx.sessions.seed({ ...session, revokedAt: null });
  // FakeHasher は入力をそのままハッシュ化するので、トークン = セッション ID。
  return { user, sessionId: session.id, token: session.id };
}

describe("RevokeSessionUseCase", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("自分のセッションを失効させられる", async () => {
    const { token, sessionId } = seedLoggedInUser(ctx);

    const result = await ctx.revokeSession.execute({
      sessionToken: token,
      targetSessionId: sessionId,
    });

    expect(result).toEqual({ ok: true, value: { revoked: true, self: true } });
    expect((await ctx.sessions.findById(sessionId))?.isRevoked).toBe(true);
  });

  it("別端末を失効させたときは self=false を返す", async () => {
    // Presentation 側はこれを見て Cookie を落とすか決める。
    // revoked だけで判断すると、他端末を切った操作で自分がログアウトされる。
    const { token, user } = seedLoggedInUser(ctx);
    const other = aSession({ userId: user.id });
    ctx.sessions.seed({ ...other, revokedAt: null });

    const result = await ctx.revokeSession.execute({
      sessionToken: token,
      targetSessionId: other.id,
    });

    expect(result).toEqual({ ok: true, value: { revoked: true, self: false } });
  });

  it("他人のセッションは失効させられない", async () => {
    const attacker = seedLoggedInUser(ctx);
    const victim = seedLoggedInUser(ctx);

    const result = await ctx.revokeSession.execute({
      sessionToken: attacker.token,
      targetSessionId: victim.sessionId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
    // 被害者のセッションは無傷。
    expect((await ctx.sessions.findById(victim.sessionId))?.isRevoked).toBe(false);
  });

  it("他人のセッションと存在しないセッションを区別できる応答を返さない", async () => {
    const attacker = seedLoggedInUser(ctx);
    const victim = seedLoggedInUser(ctx);

    const other = await ctx.revokeSession.execute({
      sessionToken: attacker.token,
      targetSessionId: victim.sessionId,
    });
    const missing = await ctx.revokeSession.execute({
      sessionToken: attacker.token,
      targetSessionId: "ses_does_not_exist",
    });

    // 応答が同じでないと、セッション ID の実在を探る手段になる。
    expect(other).toEqual(missing);
  });

  it("無効なセッショントークンでは認証エラーになる", async () => {
    const result = await ctx.revokeSession.execute({
      sessionToken: "not-a-real-token",
      targetSessionId: "ses_anything",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unauthenticated");
  });

  it("失効済みのセッショントークンでは操作できない", async () => {
    const { token, sessionId } = seedLoggedInUser(ctx);
    await ctx.sessions.revoke(sessionId, NOW);

    const result = await ctx.revokeSession.execute({
      sessionToken: token,
      targetSessionId: sessionId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unauthenticated");
  });
});

describe("GetSessionUseCase", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("有効なセッションを解決できる", async () => {
    const { token, user } = seedLoggedInUser(ctx);

    const result = await ctx.getSession.execute({ sessionToken: token });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.userId).toBe(user.id);
  });

  it("期限切れのセッションは null になる", async () => {
    const { token } = seedLoggedInUser(ctx);
    ctx.clock.advance(13 * 60 * 60 * 1000); // 12 時間の上限を超える

    const result = await ctx.getSession.execute({ sessionToken: token });

    expect(result).toEqual({ ok: true, value: null });
    expect(ctx.audit.eventNames()).toContain("session.rejected");
  });

  it("停止中ユーザーのセッションは期限内でも通さない", async () => {
    const user = aUser({ status: "suspended" });
    ctx.users.seed(user);
    const session = aSession({ userId: user.id });
    ctx.sessions.seed({ ...session, revokedAt: null });

    const result = await ctx.getSession.execute({ sessionToken: session.id });

    expect(result).toEqual({ ok: true, value: null });
  });

  it("論理削除されたユーザーは status が active のままでも通さない", async () => {
    // deleted_at だけ立てて status を戻し忘れる運用は起こりうる。
    // status しか見ていないと、削除済みユーザーがログインし続けられる。
    const user = aUser({ status: "active", deletedAt: NOW });
    ctx.users.seed(user);
    const session = aSession({ userId: user.id });
    ctx.sessions.seed({ ...session, revokedAt: null });

    const result = await ctx.getSession.execute({ sessionToken: session.id });

    expect(result).toEqual({ ok: true, value: null });
  });
});

describe("ListSessionsUseCase", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("自分のセッションだけを返し、現在のセッションに印をつける", async () => {
    const me = seedLoggedInUser(ctx);
    const second = aSession({ userId: me.user.id });
    ctx.sessions.seed({ ...second, revokedAt: null });
    const stranger = seedLoggedInUser(ctx);

    const result = await ctx.listSessions.execute({ sessionToken: me.token });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) throw new Error("expected sessions");

    const ids = result.value.map((i) => i.session.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(me.sessionId);
    expect(ids).toContain(second.id);
    expect(ids).not.toContain(stranger.sessionId);

    expect(result.value.find((i) => i.session.id === me.sessionId)?.current).toBe(true);
    expect(result.value.find((i) => i.session.id === second.id)?.current).toBe(false);
  });

  it("失効済みのセッションは一覧に出さない", async () => {
    const me = seedLoggedInUser(ctx);
    const dead = aSession({ userId: me.user.id });
    ctx.sessions.seed({ ...dead, revokedAt: NOW });

    const result = await ctx.listSessions.execute({ sessionToken: me.token });

    if (!result.ok || result.value === null) throw new Error("expected sessions");
    expect(result.value.map((i) => i.session.id)).toEqual([me.sessionId]);
  });
});
