import { FixedClock, aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { StartEmailOtpUseCase } from "../src/application/use-cases/start-email-otp.use-case";
import { RetentionPolicy } from "../src/domain/services/retention-policy";
import { OtpPolicy, TokenLifetime } from "../src/domain/services/token-lifetime";
import { WebCryptoTokenGenerator } from "../src/infrastructure/crypto/web-crypto";
import { FakeHasher, InMemoryUserRepository, RecordingAuditLogger } from "./fakes";
import { InMemoryEmailChallengeRepository, RecordingEmailSender } from "./fakes.otp";

/**
 * OTP 再送上限（#88）。
 *
 * 以前の実装では上限が**一度も発動しなかった**。`email_challenges.resend_count`
 * で数える設計だったのに、送信のたびに新しい行を作るのでカウンタは常に 0 に
 * 戻り、列を進める `recordResend()` はどこからも呼ばれていなかった。効いていた
 * のは 60 秒のクールダウンだけで、任意のアドレスへ 60 秒ごとに無制限に
 * メールを送れた。
 *
 * ここで固定するのは次の 3 つ:
 *  1. クールダウンを跨いでも窓あたりの通数で止まること
 *  2. 止まっても**応答が変わらない**こと（変えるとアドレスの実在が分かる）
 *  3. 保持期限の掃除で上限を回り込めないこと（#43 との相互作用）
 */

const NOW = new Date("2026-10-24T00:00:00.000Z");
const EMAIL = "taro@example.com";

/** 窓あたりに送れる通数。最初の 1 通は再送ではない。 */
const SENDS_PER_WINDOW = OtpPolicy.maxResends + 1;

function setup() {
  const users = new InMemoryUserRepository();
  const challenges = new InMemoryEmailChallengeRepository();
  const audit = new RecordingAuditLogger();
  const clock = new FixedClock(NOW);
  const emailSender = new RecordingEmailSender();

  return {
    users,
    challenges,
    audit,
    clock,
    emailSender,
    start: new StartEmailOtpUseCase({
      users,
      challenges,
      email: emailSender,
      hasher: new FakeHasher(),
      tokens: new WebCryptoTokenGenerator(),
      clock,
      audit,
    }),
  };
}

describe("OTP 再送上限", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
    ctx.users.seed(aUser({ email: EMAIL }));
  });

  /** クールダウンだけ待って送れるだけ送る。実経路の「再送ボタン連打」に相当する。 */
  async function sendAfterCooldown(times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      if (i > 0) ctx.clock.advance(OtpPolicy.resendCooldownMs);
      await ctx.start.execute({ email: EMAIL, purpose: "login" });
    }
  }

  it("クールダウンを跨いでも窓あたりの通数で止まる", async () => {
    await sendAfterCooldown(SENDS_PER_WINDOW + 5);

    expect(ctx.emailSender.sent).toHaveLength(SENDS_PER_WINDOW);
  });

  it("OTP の期限が切れて active が消えても上限は効く", async () => {
    // これが #88 の本体。上限判定はクールダウンと同じ `if (active != null)` の
    // 中にあったので、OTP の寿命（5 分）を待てば判定ごと素通りできた。
    for (let i = 0; i < SENDS_PER_WINDOW + 5; i += 1) {
      ctx.clock.advance(TokenLifetime.emailOtpMs + 1000);
      expect(await ctx.challenges.findActive(EMAIL, "login", ctx.clock.now())).toBeNull();
      await ctx.start.execute({ email: EMAIL, purpose: "login" });
    }

    expect(ctx.emailSender.sent).toHaveLength(SENDS_PER_WINDOW);
  });

  it("上限に達しても応答を変えない", async () => {
    // 打ち止めだと分かると、このエンドポイントが「このアドレスは登録済みか」を
    // 調べる道具になる。送れたときと同じ値でなければならない。
    const first = await ctx.start.execute({ email: EMAIL, purpose: "login" });
    await sendAfterCooldown(SENDS_PER_WINDOW + 1);
    ctx.clock.advance(OtpPolicy.resendCooldownMs);
    const blocked = await ctx.start.execute({ email: EMAIL, purpose: "login" });

    expect(blocked).toEqual(first);
  });

  it("未登録アドレスの応答とも区別がつかない", async () => {
    await sendAfterCooldown(SENDS_PER_WINDOW + 1);
    ctx.clock.advance(OtpPolicy.resendCooldownMs);

    const blocked = await ctx.start.execute({ email: EMAIL, purpose: "login" });
    const unknown = await ctx.start.execute({ email: "nobody@example.com", purpose: "login" });

    expect(blocked).toEqual(unknown);
  });

  it("窓を抜ければまた送れる", async () => {
    await sendAfterCooldown(SENDS_PER_WINDOW + 1);
    expect(ctx.emailSender.sent).toHaveLength(SENDS_PER_WINDOW);

    ctx.clock.advance(OtpPolicy.resendWindowMs + 1000);
    await ctx.start.execute({ email: EMAIL, purpose: "login" });

    expect(ctx.emailSender.sent).toHaveLength(SENDS_PER_WINDOW + 1);
  });

  it("用途が違えば別勘定になる", async () => {
    // login を打ち止めにしても、本人の signup / recovery まで巻き添えにしない。
    await sendAfterCooldown(SENDS_PER_WINDOW + 1);
    ctx.emailSender.sent.length = 0;

    await ctx.start.execute({ email: EMAIL, purpose: "verify_email" });

    expect(ctx.emailSender.sent).toHaveLength(1);
  });

  it("打ち止めを監査ログに残す", async () => {
    await sendAfterCooldown(SENDS_PER_WINDOW + 1);
    ctx.clock.advance(OtpPolicy.resendCooldownMs);
    await ctx.start.execute({ email: EMAIL, purpose: "login" });

    expect(ctx.audit.events).toContainEqual(
      expect.objectContaining({ event: "otp.start", outcome: "failure", reason: "resend_limit" }),
    );
  });
});

describe("保持期限との相互作用（#43）", () => {
  it("窓は保持期間を超えてはならない", () => {
    // 数える材料は email_challenges の行そのもの。窓のほうが長いと、
    // 古い行が掃除で消えた時点で送信履歴が失われ、待つだけで上限を
    // 回り込める。どちらの定数を動かしてもここで止まる。
    expect(OtpPolicy.resendWindowMs).toBeLessThanOrEqual(RetentionPolicy.email_challenges);
  });

  it("掃除を走らせても窓の中の行は消えないので上限は効いたまま", async () => {
    const ctx = setup();
    ctx.users.seed(aUser({ email: EMAIL }));

    for (let i = 0; i < OtpPolicy.maxResends + 1; i += 1) {
      if (i > 0) ctx.clock.advance(OtpPolicy.resendCooldownMs);
      await ctx.start.execute({ email: EMAIL, purpose: "login" });
    }
    expect(ctx.emailSender.sent).toHaveLength(SENDS_PER_WINDOW);

    // 保持期限が来た行を実際に落とす。掃除の境界は「作成時刻」ではなく
    // 「使えなくなった時刻」なので、ここは窓より確実に緩い条件になる。
    const purged = ctx.challenges.purgeCreatedBefore(
      new Date(ctx.clock.now().getTime() - RetentionPolicy.email_challenges),
    );
    expect(purged).toBe(0);

    ctx.clock.advance(OtpPolicy.resendCooldownMs);
    await ctx.start.execute({ email: EMAIL, purpose: "login" });

    expect(ctx.emailSender.sent).toHaveLength(SENDS_PER_WINDOW);
  });
});
