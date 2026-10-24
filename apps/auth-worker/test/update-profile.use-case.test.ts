import { FixedClock, aSession, aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { GetSessionUseCase } from "../src/application/use-cases/get-session.use-case";
import { UpdateProfileUseCase } from "../src/application/use-cases/update-profile.use-case";
import { ReauthenticationPolicy } from "../src/domain/services/reauthentication";
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
    updateProfile: new UpdateProfileUseCase({ getSession, users, clock, audit }),
  };
}

/**
 * ログイン済みの利用者を作る。
 *
 * `authenticatedAt` はセッションの作成時刻、つまり「最後に本人確認を通した時刻」。
 * 既定では今なので、再認証を要求する操作もそのまま通る。
 */
function seedLoggedInUser(
  ctx: ReturnType<typeof setup>,
  overrides: { username?: string; authenticatedAt?: Date } = {},
) {
  const user = aUser(overrides.username ? { username: overrides.username } : {});
  ctx.users.seed(user);
  const session = aSession({ userId: user.id, createdAt: overrides.authenticatedAt ?? NOW });
  ctx.sessions.seed({ ...session, revokedAt: null });
  // FakeHasher は入力をそのままハッシュ化するので、トークン = セッション ID。
  return { user, token: session.id };
}

/** 再認証の窓を 1 分超えたセッション。 */
const STALE = new Date(NOW.getTime() - ReauthenticationPolicy.freshnessMs - 60 * 1000);

describe("UpdateProfileUseCase", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("displayName を変更できる", async () => {
    const { token, user } = seedLoggedInUser(ctx);

    const result = await ctx.updateProfile.execute({
      sessionToken: token,
      displayName: " 新 名前 ",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 前後の空白は落として保存する。見た目が同じで値が違う表示名を作らせない。
    expect(result.value.user.displayName).toBe("新 名前");
    expect(result.value.changedFields).toEqual(["displayName"]);
    expect((await ctx.users.findById(user.id))?.displayName).toBe("新 名前");
  });

  it("username を変更すると小文字へ正規化される", async () => {
    const { token, user } = seedLoggedInUser(ctx);

    const result = await ctx.updateProfile.execute({ sessionToken: token, username: "NewName" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.user.username).toBe("newname");
    expect((await ctx.users.findById(user.id))?.username).toBe("newname");
  });

  it.each([
    ["予約語", "admin"],
    ["短すぎ", "ab"],
    ["記号", "new.name"],
    ["長すぎ", "a".repeat(33)],
  ])("%s の username は受け付けない", async (_label, username) => {
    const { token, user } = seedLoggedInUser(ctx);
    const before = user.username;

    const result = await ctx.updateProfile.execute({ sessionToken: token, username });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_input");
    expect((await ctx.users.findById(user.id))?.username).toBe(before);
  });

  it.each([
    ["空文字", ""],
    ["空白だけ", "   "],
    ["長すぎ", "a".repeat(65)],
  ])("%s の displayName は受け付けない", async (_label, displayName) => {
    const { token } = seedLoggedInUser(ctx);

    const result = await ctx.updateProfile.execute({ sessionToken: token, displayName });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_input");
  });

  it("他人が使っている username は大文字小文字を無視して弾く", async () => {
    seedLoggedInUser(ctx, { username: "takenname" });
    const me = seedLoggedInUser(ctx);

    const result = await ctx.updateProfile.execute({
      sessionToken: me.token,
      username: "TakenName",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
    expect((await ctx.users.findById(me.user.id))?.username).toBe(me.user.username);
  });

  it("衝突の応答が相手のアカウント状態で変わらない", async () => {
    // 「停止中の人が持っている」と「有効な人が持っている」が区別できると、
    // username からアカウントの状態を探れてしまう（仕様書 9）。
    ctx.users.seed(aUser({ username: "activeholder" }));
    ctx.users.seed(aUser({ username: "suspendedholder", status: "suspended" }));
    const me = seedLoggedInUser(ctx);

    const taken = await ctx.updateProfile.execute({
      sessionToken: me.token,
      username: "activeholder",
    });
    const takenBySuspended = await ctx.updateProfile.execute({
      sessionToken: me.token,
      username: "suspendedholder",
    });

    expect(taken).toEqual(takenBySuspended);
  });

  it("username の変更には直近の認証が要る", async () => {
    const { token, user } = seedLoggedInUser(ctx, { authenticatedAt: STALE });

    const result = await ctx.updateProfile.execute({ sessionToken: token, username: "newname" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("reauthentication_required");
    expect((await ctx.users.findById(user.id))?.username).toBe(user.username);
  });

  it("displayName の変更には再認証を求めない", async () => {
    // 表示名はなりすましに直結せず、本人がすぐ気づいて戻せる。
    // ここまで再認証を求めると、確認手続きそのものが素通りされるようになる。
    const { token } = seedLoggedInUser(ctx, { authenticatedAt: STALE });

    const result = await ctx.updateProfile.execute({ sessionToken: token, displayName: "別名" });

    expect(result.ok).toBe(true);
  });

  it("再認証の判定を username の衝突確認より先に行う", async () => {
    // 逆順だと、古いセッションしか無い相手でも応答の違いから
    // 「その username は埋まっているか」を確かめられる。
    ctx.users.seed(aUser({ username: "takenname" }));
    const { token } = seedLoggedInUser(ctx, { authenticatedAt: STALE });

    const taken = await ctx.updateProfile.execute({ sessionToken: token, username: "takenname" });
    const free = await ctx.updateProfile.execute({ sessionToken: token, username: "freename" });

    expect(taken).toEqual(free);
  });

  it("同じ値を送っても書き込まない", async () => {
    const { token, user } = seedLoggedInUser(ctx);
    const before = (await ctx.users.findById(user.id))?.updatedAt;

    const result = await ctx.updateProfile.execute({
      sessionToken: token,
      displayName: user.displayName,
      username: user.username,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.changedFields).toEqual([]);
    expect((await ctx.users.findById(user.id))?.updatedAt).toEqual(before);
    // 何も変わっていない操作で監査ログを埋めない。
    expect(ctx.audit.eventNames()).not.toContain("profile.updated");
  });

  it("同じ username を再認証なしで送り直しても拒否されない", async () => {
    // 変更が無いなら、そもそも再認証を要求する操作ではない。
    const { token, user } = seedLoggedInUser(ctx, { authenticatedAt: STALE });

    const result = await ctx.updateProfile.execute({
      sessionToken: token,
      username: user.username,
    });

    expect(result.ok).toBe(true);
  });

  it("変更する項目が 1 つも無い要求は受け付けない", async () => {
    const { token } = seedLoggedInUser(ctx);

    const result = await ctx.updateProfile.execute({ sessionToken: token });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_input");
  });

  it("未ログインでは変更できない", async () => {
    const result = await ctx.updateProfile.execute({
      sessionToken: "not-a-real-token",
      displayName: "誰か",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unauthenticated");
  });

  it("監査ログに変更後の値を残さない", async () => {
    const { token } = seedLoggedInUser(ctx);

    await ctx.updateProfile.execute({
      sessionToken: token,
      displayName: "本名っぽい表示名",
      username: "newname",
    });

    const event = ctx.audit.events.find((e) => e.event === "profile.updated");
    expect(event?.outcome).toBe("success");
    expect(event?.metadata).toEqual({ fields: ["displayName", "username"] });
    // 監査ログは users より長く残り、読む相手も広い。値を写すと同じ個人情報が
    // 保持期間の違う場所に増える（仕様書 9 Privacy）。
    expect(JSON.stringify(event)).not.toContain("本名っぽい表示名");
    expect(JSON.stringify(event)).not.toContain("newname");
  });
});
