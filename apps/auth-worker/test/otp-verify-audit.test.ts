import { FixedClock, aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { IssueSessionUseCase } from "../src/application/use-cases/issue-session.use-case";
import { VerifyEmailOtpUseCase } from "../src/application/use-cases/verify-email-otp.use-case";
import { PepperedIpHasher, WebCryptoTokenGenerator } from "../src/infrastructure/crypto/web-crypto";
import {
  FakeHasher,
  InMemorySessionRepository,
  InMemoryUserRepository,
  RecordingAuditLogger,
} from "./fakes";
import { InMemoryEmailChallengeRepository } from "./fakes.otp";

/**
 * OTP 検証の**成功側**が監査ログに残ること（#151）。
 *
 * `audit.record` を呼んでいるのは `recordFailure()` だけで、`consumed` を
 * 抜けた先の成功経路に記録が 1 つも無かった。結果:
 *
 *  - **`otp.verify` は失敗だけが記録される**非対称な状態。「この試行は
 *    成功したのか」を監査ログ単体で答えられず、隣接する `session.issue`
 *    から推測する必要があった
 *  - signup でユーザーが生まれても、**作成の記録がどこにも残らない**。
 *    `users.created_at` はあるが、保持期限・R2 への退避・調査手順が
 *    乗っているのは `audit_logs` の側である
 *
 * 本番で初回サインアップを 1 周通したときに観測された（ユーザーが作られた
 * 時刻に `session.issue` しか残っていなかった）。
 */

const NOW = new Date("2026-10-25T00:00:00.000Z");
const EMAIL = "signup-probe@example.com";
const CODE = "424242";

function setup() {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const challenges = new InMemoryEmailChallengeRepository();
  const audit = new RecordingAuditLogger();
  const clock = new FixedClock(NOW);
  const hasher = new FakeHasher();

  return {
    users,
    challenges,
    audit,
    verify: new VerifyEmailOtpUseCase({
      users,
      challenges,
      issueSession: new IssueSessionUseCase({
        users,
        sessions,
        hasher,
        ipHasher: new PepperedIpHasher("test"),
        tokens: new WebCryptoTokenGenerator(),
        clock,
        audit,
      }),
      hasher,
      clock,
      audit,
    }),
  };
}

type Ctx = ReturnType<typeof setup>;

/** 検証を通せる状態の challenge を直接仕込む。コードは本来メールでしか届かない。 */
async function seedChallenge(ctx: Ctx, purpose: "login" | "signup"): Promise<void> {
  await ctx.challenges.create({
    id: "emc_probe",
    userId: null,
    email: EMAIL,
    codeHash: await new FakeHasher().hash(CODE),
    purpose,
    expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000),
    maxAttempts: 5,
    sentAt: NOW,
  });
}

function eventsNamed(ctx: Ctx, name: string) {
  return ctx.audit.events.filter((e) => e.event === name);
}

describe("OTP 検証の成功が監査ログに残る", () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it("成功したら otp.verify が success として残る", async () => {
    ctx.users.seed(aUser({ email: EMAIL }));
    await seedChallenge(ctx, "login");

    const result = await ctx.verify.execute({
      email: EMAIL,
      code: CODE,
      purpose: "login",
      userAgent: "vitest",
      ip: null,
    });

    expect(result.ok, "検証の成功経路を通せていない").toBe(true);
    expect(eventsNamed(ctx, "otp.verify")).toEqual([
      expect.objectContaining({ outcome: "success" }),
    ]);
  });

  it("1 回の呼び出しで otp.verify はちょうど 1 行", async () => {
    // `consume` の直後に成功を書くと、その先の user_missing /
    // issue_session:* で失敗したときに成功と失敗が 2 行並ぶ。
    // 成功・失敗のどちらの経路でも 1 行であることを固定する。
    ctx.users.seed(aUser({ email: EMAIL }));
    await seedChallenge(ctx, "login");
    await ctx.verify.execute({
      email: EMAIL,
      code: CODE,
      purpose: "login",
      userAgent: null,
      ip: null,
    });

    expect(eventsNamed(ctx, "otp.verify")).toHaveLength(1);
  });

  it("失敗側は従来どおり failure 1 行のまま", async () => {
    await seedChallenge(ctx, "login");

    await ctx.verify.execute({
      email: EMAIL,
      code: "000000",
      purpose: "login",
      userAgent: null,
      ip: null,
    });

    expect(eventsNamed(ctx, "otp.verify")).toEqual([
      expect.objectContaining({ outcome: "failure" }),
    ]);
  });
});

describe("アカウント作成が監査ログに残る", () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it("signup で新規作成されたら user.created が残る", async () => {
    await seedChallenge(ctx, "signup");

    const result = await ctx.verify.execute({
      email: EMAIL,
      code: CODE,
      purpose: "signup",
      userAgent: "vitest",
      ip: null,
    });

    expect(result.ok, "サインアップの成功経路を通せていない").toBe(true);
    const created = eventsNamed(ctx, "user.created");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ outcome: "success" });
    expect(created[0]?.userId, "作られた利用者に紐づいていない").toBeDefined();
  });

  it("既にいる利用者には user.created を記録しない", async () => {
    // signup の purpose でも、そのアドレスの持ち主が既にいれば
    // 既存アカウントへのログインとして扱う。ここで記録すると
    // 「新規作成」と「既存へのログイン」が区別できなくなる。
    ctx.users.seed(aUser({ email: EMAIL }));
    await seedChallenge(ctx, "signup");

    await ctx.verify.execute({
      email: EMAIL,
      code: CODE,
      purpose: "signup",
      userAgent: null,
      ip: null,
    });

    expect(eventsNamed(ctx, "user.created")).toEqual([]);
  });

  it("login では user.created を記録しない", async () => {
    ctx.users.seed(aUser({ email: EMAIL }));
    await seedChallenge(ctx, "login");

    await ctx.verify.execute({
      email: EMAIL,
      code: CODE,
      purpose: "login",
      userAgent: null,
      ip: null,
    });

    expect(eventsNamed(ctx, "user.created")).toEqual([]);
  });
});

describe("足した記録に秘密が入らない", () => {
  it("平文のメールアドレスを残さない", async () => {
    // 足したのは成功側なので、#123 の走査（失敗側を厚く通している）とは
    // 別に押さえておく。伏せ字は `EmailAddress.masked` を使う。
    const ctx = setup();
    await seedChallenge(ctx, "signup");

    await ctx.verify.execute({
      email: EMAIL,
      code: CODE,
      purpose: "signup",
      userAgent: null,
      ip: null,
    });

    expect(JSON.stringify(ctx.audit.events)).not.toContain(EMAIL);
    expect(JSON.stringify(ctx.audit.events)).not.toContain("signup-probe");
  });
});
