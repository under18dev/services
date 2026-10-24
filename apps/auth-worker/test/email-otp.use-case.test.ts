import { FixedClock, aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { GetSessionUseCase } from "../src/application/use-cases/get-session.use-case";
import { IssueSessionUseCase } from "../src/application/use-cases/issue-session.use-case";
import { StartEmailOtpUseCase } from "../src/application/use-cases/start-email-otp.use-case";
import { VerifyEmailOtpUseCase } from "../src/application/use-cases/verify-email-otp.use-case";
import { PepperedIpHasher, WebCryptoTokenGenerator } from "../src/infrastructure/crypto/web-crypto";
import {
  FakeHasher,
  InMemorySessionRepository,
  InMemoryUserRepository,
  RecordingAuditLogger,
} from "./fakes";
import {
  FailingEmailSender,
  InMemoryEmailChallengeRepository,
  RecordingEmailSender,
} from "./fakes.otp";
import type { EmailSender } from "../src/application/ports/email-sender.port";

const NOW = new Date("2026-10-24T00:00:00.000Z");
const EMAIL = "taro@example.com";

function setup(emailSender: EmailSender = new RecordingEmailSender()) {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const challenges = new InMemoryEmailChallengeRepository();
  const audit = new RecordingAuditLogger();
  const clock = new FixedClock(NOW);
  const hasher = new FakeHasher();

  const issueSession = new IssueSessionUseCase({
    users,
    sessions,
    hasher,
    ipHasher: new PepperedIpHasher("test"),
    tokens: new WebCryptoTokenGenerator(),
    clock,
    audit,
  });

  return {
    users,
    sessions,
    challenges,
    audit,
    clock,
    emailSender,
    start: new StartEmailOtpUseCase({
      users,
      challenges,
      email: emailSender,
      hasher,
      tokens: new WebCryptoTokenGenerator(),
      clock,
      audit,
    }),
    verify: new VerifyEmailOtpUseCase({
      users,
      challenges,
      issueSession,
      hasher,
      clock,
      audit,
    }),
    getSession: new GetSessionUseCase({ sessions, users, hasher, clock, audit }),
  };
}

/** 直近に送られた OTP を取り出す。実経路では利用者のメールに届く値。 */
function lastCode(ctx: ReturnType<typeof setup>): string {
  const sender = ctx.emailSender as RecordingEmailSender;
  const code = sender.sent.at(-1)?.code;
  if (code === undefined) throw new Error("no otp was sent");
  return code;
}

describe("StartEmailOtpUseCase", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("登録済みアドレスには OTP を送る", async () => {
    ctx.users.seed(aUser({ email: EMAIL }));

    const result = await ctx.start.execute({ email: EMAIL, purpose: "login" });

    expect(result.ok).toBe(true);
    expect(lastCode(ctx)).toMatch(/^\d{6}$/);
  });

  it("未登録アドレスでも同じ応答を返す（アカウント列挙の防止）", async () => {
    const known = setup();
    known.users.seed(aUser({ email: EMAIL }));
    const unknown = setup();

    const a = await known.start.execute({ email: EMAIL, purpose: "login" });
    const b = await unknown.start.execute({ email: EMAIL, purpose: "login" });

    // 応答が 1 ビットでも違えば、このエンドポイントが在籍確認に使える。
    expect(a).toEqual(b);
  });

  it("未登録アドレスには実際には送らない", async () => {
    await ctx.start.execute({ email: "nobody@example.com", purpose: "login" });

    expect((ctx.emailSender as RecordingEmailSender).sent).toHaveLength(0);
    expect(ctx.challenges.size()).toBe(0);
  });

  it("停止中ユーザーには送らないが応答は変えない", async () => {
    ctx.users.seed(aUser({ email: EMAIL, status: "suspended" }));

    const result = await ctx.start.execute({ email: EMAIL, purpose: "login" });

    expect(result.ok).toBe(true);
    expect((ctx.emailSender as RecordingEmailSender).sent).toHaveLength(0);
  });

  it("送信が失敗しても応答を変えない", async () => {
    // ここで 500 を返すと「送信を試みた＝アカウントがある」と分かる。
    const failing = setup(new FailingEmailSender());
    failing.users.seed(aUser({ email: EMAIL }));

    const result = await failing.start.execute({ email: EMAIL, purpose: "login" });

    expect(result.ok).toBe(true);
  });

  it("クールダウン中は新しいコードを出さない", async () => {
    ctx.users.seed(aUser({ email: EMAIL }));
    await ctx.start.execute({ email: EMAIL, purpose: "login" });

    ctx.clock.advance(10_000); // クールダウンは 60 秒
    await ctx.start.execute({ email: EMAIL, purpose: "login" });

    expect((ctx.emailSender as RecordingEmailSender).sent).toHaveLength(1);
  });

  it("クールダウン後は再送できる", async () => {
    ctx.users.seed(aUser({ email: EMAIL }));
    await ctx.start.execute({ email: EMAIL, purpose: "login" });

    ctx.clock.advance(61_000);
    await ctx.start.execute({ email: EMAIL, purpose: "login" });

    expect((ctx.emailSender as RecordingEmailSender).sent).toHaveLength(2);
  });

  it("再送すると古いコードは無効になる", async () => {
    // 有効なコードが増えると総当たりが楽になる。
    ctx.users.seed(aUser({ email: EMAIL }));
    await ctx.start.execute({ email: EMAIL, purpose: "login" });
    const old = lastCode(ctx);

    ctx.clock.advance(61_000);
    await ctx.start.execute({ email: EMAIL, purpose: "login" });

    const result = await ctx.verify.execute({
      email: EMAIL,
      code: old,
      purpose: "login",
      userAgent: null,
      ip: null,
    });
    expect(result.ok).toBe(false);
  });

  it("形式が不正なアドレスは拒否する", async () => {
    const result = await ctx.start.execute({ email: "not-an-email", purpose: "login" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_input");
  });

  it("signup では未登録アドレスにだけ送る", async () => {
    ctx.users.seed(aUser({ email: EMAIL }));

    await ctx.start.execute({ email: EMAIL, purpose: "signup" });

    expect((ctx.emailSender as RecordingEmailSender).sent).toHaveLength(0);
  });
});

describe("VerifyEmailOtpUseCase", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  async function requestCode(email = EMAIL) {
    await ctx.start.execute({ email, purpose: "login" });
    return lastCode(ctx);
  }

  it("正しいコードでセッションを発行する", async () => {
    const user = ctx.users.seed(aUser({ email: EMAIL }));
    const code = await requestCode();

    const result = await ctx.verify.execute({
      email: EMAIL,
      code,
      purpose: "login",
      userAgent: "vitest",
      ip: "203.0.113.1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.session.userId).toBe(user.id);
    expect(result.value.session.authMethod).toBe("email_otp");

    const resolved = await ctx.getSession.execute({ sessionToken: result.value.token });
    expect(resolved.ok && resolved.value?.userId).toBe(user.id);
  });

  it("同じコードで 2 回ログインできない", async () => {
    ctx.users.seed(aUser({ email: EMAIL }));
    const code = await requestCode();

    await ctx.verify.execute({
      email: EMAIL,
      code,
      purpose: "login",
      userAgent: null,
      ip: null,
    });
    const second = await ctx.verify.execute({
      email: EMAIL,
      code,
      purpose: "login",
      userAgent: null,
      ip: null,
    });

    expect(second.ok).toBe(false);
  });

  it("誤ったコードは拒否する", async () => {
    ctx.users.seed(aUser({ email: EMAIL }));
    await requestCode();

    const result = await ctx.verify.execute({
      email: EMAIL,
      code: "000000",
      purpose: "login",
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_code");
  });

  it("試行上限を超えると 429 相当になる", async () => {
    ctx.users.seed(aUser({ email: EMAIL }));
    const code = await requestCode();

    for (let i = 0; i < 5; i += 1) {
      await ctx.verify.execute({
        email: EMAIL,
        code: "000000",
        purpose: "login",
        userAgent: null,
        ip: null,
      });
    }

    // 上限到達後は正しいコードでも通さない。
    const result = await ctx.verify.execute({
      email: EMAIL,
      code,
      purpose: "login",
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("too_many_attempts");
  });

  it("期限切れのコードは拒否する", async () => {
    ctx.users.seed(aUser({ email: EMAIL }));
    const code = await requestCode();

    ctx.clock.advance(6 * 60 * 1000); // 有効期限は 5 分

    const result = await ctx.verify.execute({
      email: EMAIL,
      code,
      purpose: "login",
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
  });

  it("未登録アドレスの検証は誤コードと同じ応答になる", async () => {
    const unknown = await ctx.verify.execute({
      email: "nobody@example.com",
      code: "000000",
      purpose: "login",
      userAgent: null,
      ip: null,
    });

    ctx.users.seed(aUser({ email: EMAIL }));
    await requestCode();
    const wrong = await ctx.verify.execute({
      email: EMAIL,
      code: "000000",
      purpose: "login",
      userAgent: null,
      ip: null,
    });

    // 「そのアドレスにコードは出ていない」と「コードが違う」を区別させない。
    expect(unknown).toEqual(wrong);
  });

  it("signup はユーザーを作る", async () => {
    await ctx.start.execute({ email: EMAIL, purpose: "signup" });
    const code = lastCode(ctx);

    const result = await ctx.verify.execute({
      email: EMAIL,
      code,
      purpose: "signup",
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(true);

    const user = await ctx.users.findByEmail(EMAIL);
    expect(user?.emailVerified).toBe(true);
  });

  it("管理者は正しいコードでもログインできない（仕様書 §14.1 決定 8）", async () => {
    // 強制点は `IssueSessionUseCase` にあり、この経路はその失敗を
    // `invalid_code` に畳む。**応答で見分けられないことまでが要件である** ——
    // 「このアドレスは管理者のものだ」と読めると、攻撃対象を絞る材料になる。
    const admin = ctx.users.seed(aUser({ email: EMAIL, isAdmin: true }));
    const code = await requestCode();

    const result = await ctx.verify.execute({
      email: EMAIL,
      code,
      purpose: "login",
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_code");
    // セッション行が生まれていないこと。「発行はするが使わせない」では、
    // 後から管理操作が増えたときにその入口が拾ってしまう。
    expect(await ctx.sessions.listByUserId(admin.id)).toEqual([]);
    expect(
      ctx.audit.events.some(
        (e) => e.event === "otp.verify" && e.reason === "issue_session:forbidden",
      ),
    ).toBe(true);
  });

  it("停止中ユーザーは正しいコードでもログインできない", async () => {
    const user = ctx.users.seed(aUser({ email: EMAIL }));
    const code = await requestCode();
    await ctx.users.updateProfile(user.id, {});
    ctx.users.seed(aUser({ id: user.id, email: EMAIL, status: "suspended" }));

    const result = await ctx.verify.execute({
      email: EMAIL,
      code,
      purpose: "login",
      userAgent: null,
      ip: null,
    });

    expect(result.ok).toBe(false);
  });
});

describe("凍結アカウントの状態を応答から読み取れない（#62）", () => {
  /**
   * `IssueSessionUseCase` は停止・論理削除されたユーザーに `forbidden` を返す。
   * それをそのまま流すと「コードは正しかったが、このアカウントは凍結されている」
   * が応答から分かってしまう。仕様書 §14.1 決定 7 により凍結アカウントの行は
   * **残り続ける**ので、この区別を残すと恒久的な列挙の窓口になる。
   *
   * 到達経路は「start と verify の間に凍結された」場合に限られる
   * （凍結済みアドレスには OTP がそもそも送られないため）。
   * ただし `StartEmailOtpUseCase.shouldSend` の条件を変えた瞬間にここが開く
   * ので、送信側の判断に依存させずに畳んでおく。
   */
  it("検証の直前に凍結されても、コード不一致と同じ応答になる", async () => {
    const ctx = setup();
    const user = aUser({ email: EMAIL });
    ctx.users.seed(user);

    await ctx.start.execute({ email: EMAIL, purpose: "login" });
    const code = lastCode(ctx);

    // ここで凍結される。コードは既に手元にある。
    ctx.users.seed({ ...user, status: "suspended" });

    const frozen = await ctx.verify.execute({
      email: EMAIL,
      purpose: "login",
      code,
      userAgent: null,
      ip: null,
    });

    // 単なる不一致と比較する。1 ビットでも違えば在籍確認に使える。
    const mismatch = await setup().verify.execute({
      email: EMAIL,
      purpose: "login",
      code: "000000",
      userAgent: null,
      ip: null,
    });

    expect(frozen).toEqual(mismatch);
    expect(frozen.ok).toBe(false);
  });

  it("凍結されたユーザーにはセッションが発行されない", async () => {
    const ctx = setup();
    const user = aUser({ email: EMAIL });
    ctx.users.seed(user);
    await ctx.start.execute({ email: EMAIL, purpose: "login" });
    const code = lastCode(ctx);
    ctx.users.seed({ ...user, status: "suspended" });

    await ctx.verify.execute({ email: EMAIL, purpose: "login", code, userAgent: null, ip: null });

    // 応答を畳んだだけで通してしまっては意味が無い。
    expect(await ctx.sessions.listByUserId(user.id)).toHaveLength(0);
  });
});
