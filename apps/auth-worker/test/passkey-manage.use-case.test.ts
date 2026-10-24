import { FixedClock, aSession, aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { DeletePasskeyUseCase } from "../src/application/use-cases/delete-passkey.use-case";
import { GetSessionUseCase } from "../src/application/use-cases/get-session.use-case";
import { ListPasskeysUseCase } from "../src/application/use-cases/list-passkeys.use-case";
import { ReauthenticationPolicy } from "../src/domain/services/reauthentication";
import {
  FakeHasher,
  InMemorySessionRepository,
  InMemoryUserRepository,
  RecordingAuditLogger,
} from "./fakes";
import { InMemoryPasskeyRepository, aPasskey } from "./fakes.passkey";

const NOW = new Date("2026-10-24T00:00:00.000Z");
/** 再認証の窓を 1 分超えたセッション。 */
const STALE = new Date(NOW.getTime() - ReauthenticationPolicy.freshnessMs - 60 * 1000);

function setup() {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const passkeys = new InMemoryPasskeyRepository();
  const audit = new RecordingAuditLogger();
  const clock = new FixedClock(NOW);
  const hasher = new FakeHasher();

  const getSession = new GetSessionUseCase({ sessions, users, hasher, clock, audit });
  return {
    users,
    sessions,
    passkeys,
    audit,
    clock,
    listPasskeys: new ListPasskeysUseCase({ getSession, passkeys }),
    deletePasskey: new DeletePasskeyUseCase({ getSession, passkeys, clock, audit }),
  };
}

function seedLoggedInUser(
  ctx: ReturnType<typeof setup>,
  overrides: { authenticatedAt?: Date } = {},
) {
  const user = aUser();
  ctx.users.seed(user);
  const session = aSession({ userId: user.id, createdAt: overrides.authenticatedAt ?? NOW });
  ctx.sessions.seed({ ...session, revokedAt: null });
  // FakeHasher は入力をそのままハッシュ化するので、トークン = セッション ID。
  return { user, token: session.id };
}

function seedPasskey(ctx: ReturnType<typeof setup>, userId: string, suffix: string) {
  return ctx.passkeys.seed(
    aPasskey({ id: `pky_${suffix}`, userId, credentialId: `cred-${suffix}`, label: suffix }),
  );
}

describe("ListPasskeysUseCase", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("自分の認証器だけを返す", async () => {
    const me = seedLoggedInUser(ctx);
    seedPasskey(ctx, me.user.id, "mine-1");
    seedPasskey(ctx, me.user.id, "mine-2");
    const stranger = seedLoggedInUser(ctx);
    seedPasskey(ctx, stranger.user.id, "theirs");

    const result = await ctx.listPasskeys.execute({ sessionToken: me.token });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) throw new Error("expected passkeys");
    expect(result.value.map((p) => p.id).sort()).toEqual(["pky_mine-1", "pky_mine-2"]);
  });

  it("無効なセッションでは一覧を返さない", async () => {
    const result = await ctx.listPasskeys.execute({ sessionToken: "not-a-real-token" });

    expect(result).toEqual({ ok: true, value: null });
  });
});

describe("DeletePasskeyUseCase", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("自分の認証器を削除できる", async () => {
    const me = seedLoggedInUser(ctx);
    seedPasskey(ctx, me.user.id, "keep");
    seedPasskey(ctx, me.user.id, "drop");

    const result = await ctx.deletePasskey.execute({
      sessionToken: me.token,
      passkeyId: "pky_drop",
    });

    expect(result).toEqual({ ok: true, value: { deleted: true, remaining: 1 } });
    expect(await ctx.passkeys.findById("pky_drop")).toBeNull();
    expect(await ctx.passkeys.findById("pky_keep")).not.toBeNull();
  });

  it("最後の 1 本も削除できる", async () => {
    // 仕様書 14.1-2 で Passkey は必須にしないと決めており、メール OTP が
    // ログイン経路として常に残る。残す設計にすると、盗まれた端末の
    // Credential がそれ 1 本だけだった利用者が外せなくなる（issue #75）。
    const me = seedLoggedInUser(ctx);
    seedPasskey(ctx, me.user.id, "only");

    const result = await ctx.deletePasskey.execute({
      sessionToken: me.token,
      passkeyId: "pky_only",
    });

    expect(result).toEqual({ ok: true, value: { deleted: true, remaining: 0 } });
    expect(await ctx.passkeys.listByUserId(me.user.id)).toEqual([]);
  });

  it("他人の認証器は削除できない", async () => {
    const attacker = seedLoggedInUser(ctx);
    const victim = seedLoggedInUser(ctx);
    seedPasskey(ctx, victim.user.id, "victim");

    const result = await ctx.deletePasskey.execute({
      sessionToken: attacker.token,
      passkeyId: "pky_victim",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
    // 被害者の認証器は無傷。
    expect(await ctx.passkeys.findById("pky_victim")).not.toBeNull();
  });

  it("他人の認証器と存在しない認証器を区別できる応答を返さない", async () => {
    const attacker = seedLoggedInUser(ctx);
    const victim = seedLoggedInUser(ctx);
    seedPasskey(ctx, victim.user.id, "victim");

    const owned = await ctx.deletePasskey.execute({
      sessionToken: attacker.token,
      passkeyId: "pky_victim",
    });
    const missing = await ctx.deletePasskey.execute({
      sessionToken: attacker.token,
      passkeyId: "pky_does_not_exist",
    });

    expect(owned).toEqual(missing);
  });

  it("古いセッションでは削除できない", async () => {
    // セッション Cookie だけで外せると、セッション盗用がそのまま
    // 認証器の剥奪になる（issue #75）。
    const me = seedLoggedInUser(ctx, { authenticatedAt: STALE });
    seedPasskey(ctx, me.user.id, "only");

    const result = await ctx.deletePasskey.execute({
      sessionToken: me.token,
      passkeyId: "pky_only",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("reauthentication_required");
    expect(await ctx.passkeys.findById("pky_only")).not.toBeNull();
  });

  it("再認証の窓の内側ならログインし直さずに削除できる", async () => {
    const me = seedLoggedInUser(ctx, {
      authenticatedAt: new Date(NOW.getTime() - ReauthenticationPolicy.freshnessMs + 1000),
    });
    seedPasskey(ctx, me.user.id, "only");

    const result = await ctx.deletePasskey.execute({
      sessionToken: me.token,
      passkeyId: "pky_only",
    });

    expect(result.ok).toBe(true);
  });

  it("再認証の判定を所有者チェックより先に行う", async () => {
    // 逆順だと、古いセッションを握った相手が応答の違いから
    // passkey ID の実在を確かめられる。
    const attacker = seedLoggedInUser(ctx, { authenticatedAt: STALE });
    const victim = seedLoggedInUser(ctx);
    seedPasskey(ctx, victim.user.id, "victim");

    const existing = await ctx.deletePasskey.execute({
      sessionToken: attacker.token,
      passkeyId: "pky_victim",
    });
    const missing = await ctx.deletePasskey.execute({
      sessionToken: attacker.token,
      passkeyId: "pky_does_not_exist",
    });

    expect(existing).toEqual(missing);
    if (!existing.ok) expect(existing.error.code).toBe("reauthentication_required");
  });

  it("未ログインでは削除できない", async () => {
    const result = await ctx.deletePasskey.execute({
      sessionToken: "not-a-real-token",
      passkeyId: "pky_anything",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unauthenticated");
  });

  it("監査ログに passkey.deleted を残し、Credential ID と公開鍵は入れない", async () => {
    const me = seedLoggedInUser(ctx);
    const passkey = seedPasskey(ctx, me.user.id, "only");

    await ctx.deletePasskey.execute({ sessionToken: me.token, passkeyId: "pky_only" });

    const event = ctx.audit.events.find((e) => e.event === "passkey.deleted");
    expect(event?.outcome).toBe("success");
    expect(event?.metadata).toMatchObject({ passkeyId: "pky_only", remaining: 0 });
    // Credential ID は他サイトの記録と突き合わせれば同じ認証器だと分かる
    // 識別子で、公開鍵と同じく監査ログに残す理由が無い（仕様書 9 Privacy）。
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(passkey.credentialId);
    expect(serialized).not.toContain(passkey.publicKey);
  });
});
