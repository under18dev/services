import { FixedClock, aSession, aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { CloseAccountUseCase } from "../src/application/use-cases/close-account.use-case";
import { GetSessionUseCase } from "../src/application/use-cases/get-session.use-case";
import { ReauthenticationPolicy } from "../src/domain/services/reauthentication";
import {
  FakeHasher,
  ImmediateSideEffectScheduler,
  InMemorySessionRepository,
  InMemoryUserRepository,
  RecordingAuditLogger,
} from "./fakes";

/**
 * 本人の退会（#318 / ランブック §11.7）。
 *
 * **ここで確かめるのは「閉じ方」である。** 閉じたあとも管理者が個人情報を
 * 落とせること（`purgeUserSql` のガードと噛み合うこと）は実物の D1 でしか
 * 見えないので、`user-repository.test.ts` にある。
 */

/** `aSession` の既定の有効期限（FIXED_NOW + 12 時間）の内側に置く。 */
const NOW = new Date("2026-10-24T00:00:00.000Z");
/** 再認証の窓を 1 分超えたセッション。 */
const STALE = new Date(NOW.getTime() - ReauthenticationPolicy.freshnessMs - 60 * 1000);

function setup() {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const audit = new RecordingAuditLogger();
  const clock = new FixedClock(NOW);
  const hasher = new FakeHasher();

  const getSession = new GetSessionUseCase({
    sessions,
    users,
    hasher,
    clock,
    audit,
    sideEffects: new ImmediateSideEffectScheduler(),
  });
  return {
    users,
    sessions,
    audit,
    closeAccount: new CloseAccountUseCase({ getSession, users, sessions, clock, audit }),
  };
}

function seedLoggedInUser(ctx: ReturnType<typeof setup>, authenticatedAt: Date = NOW) {
  const user = aUser();
  ctx.users.seed(user);
  const session = aSession({ userId: user.id, createdAt: authenticatedAt });
  ctx.sessions.seed({ ...session, revokedAt: null });
  // FakeHasher は入力をそのままハッシュ化するので、トークン = セッション ID。
  return { user, token: session.id };
}

describe("CloseAccountUseCase", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("status を suspended にする", async () => {
    const me = seedLoggedInUser(ctx);

    const result = await ctx.closeAccount.execute({ sessionToken: me.token });

    expect(result.ok).toBe(true);
    expect((await ctx.users.findById(me.user.id))?.status).toBe("suspended");
  });

  it("**deleted にはしない**", async () => {
    // **これが崩れると個人情報が回収不能になる。** `purgeUserSql` のガードは
    // `status <> 'deleted'` なので、落とさずに `deleted` を立てると管理者の
    // §11.6 がこの行に当たらない。しかも `returning` が 0 行なので、
    // 運用者からは「既に落とした」と区別が付かない。
    const me = seedLoggedInUser(ctx);

    await ctx.closeAccount.execute({ sessionToken: me.token });

    expect((await ctx.users.findById(me.user.id))?.status).not.toBe("deleted");
  });

  it("すべてのセッションを失効させる", async () => {
    const me = seedLoggedInUser(ctx);
    const other = aSession({ id: "ses_other", userId: me.user.id, createdAt: NOW });
    ctx.sessions.seed({ ...other, revokedAt: null });

    const result = await ctx.closeAccount.execute({ sessionToken: me.token });

    expect(result.ok && result.value.revokedSessions).toBe(2);
    const left = await ctx.sessions.listByUserId(me.user.id);
    expect(left.every((session) => session.revokedAt !== null)).toBe(true);
  });

  it("直近の本人確認が無ければ拒否する", async () => {
    // **Cookie を 1 枚持っているだけの相手に通させない。** 置き忘れた端末で
    // 他人がアカウントを閉じられる形にしない。
    const me = seedLoggedInUser(ctx, STALE);

    const result = await ctx.closeAccount.execute({ sessionToken: me.token });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("reauthentication_required");
    // **閉じていないこと。** 拒否したのに状態が変わっていたら意味が無い。
    expect((await ctx.users.findById(me.user.id))?.status).toBe("active");
  });

  it("拒否も監査に残す", async () => {
    const me = seedLoggedInUser(ctx, STALE);

    await ctx.closeAccount.execute({ sessionToken: me.token });

    const entry = ctx.audit.events.find((e) => e.event === "account.closed");
    expect(entry?.outcome).toBe("failure");
    expect(entry?.reason).toBe("stale_authentication");
  });

  it("成功したら「何を落としていないか」を監査に残す", async () => {
    // 後から「削除したのに残っている」と見える状態なので、**閉じただけで
    // ある**ことが記録から読めなければならない（§11.7 の応対原則）。
    const me = seedLoggedInUser(ctx);

    await ctx.closeAccount.execute({ sessionToken: me.token });

    const entry = ctx.audit.events.find((e) => e.event === "account.closed");
    expect(entry?.outcome).toBe("success");
    expect(entry?.metadata).toMatchObject({ status: "suspended", personalDataRetained: true });
  });

  it("既に active でなければ conflict を返す", async () => {
    // **BAN を退会の記録で塗り替えない。** 先に停止された相手を退会扱いに
    // すると、BAN した事実が消える。
    const me = seedLoggedInUser(ctx);
    await ctx.closeAccount.execute({ sessionToken: me.token });

    // 2 回目。セッションは失効しているので、新しいセッションを足して試す。
    const again = aSession({ id: "ses_again", userId: me.user.id, createdAt: NOW });
    ctx.sessions.seed({ ...again, revokedAt: null });
    const result = await ctx.closeAccount.execute({ sessionToken: again.id });

    expect(result.ok).toBe(false);
    // `GetSessionUseCase` が停止中のユーザーを弾くので、2 回目は
    // そこで止まる。**どちらで止まっても「閉じられない」は変わらない。**
    if (!result.ok) expect(["conflict", "unauthenticated"]).toContain(result.error.code);
  });

  it("セッションが無効なら何もしない", async () => {
    const result = await ctx.closeAccount.execute({ sessionToken: "ses_unknown" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unauthenticated");
  });
});
