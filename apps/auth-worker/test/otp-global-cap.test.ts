import { FixedClock, aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { StartEmailOtpUseCase } from "../src/application/use-cases/start-email-otp.use-case";
import { RetentionPolicy } from "../src/domain/services/retention-policy";
import { OtpPolicy } from "../src/domain/services/token-lifetime";
import { WebCryptoTokenGenerator } from "../src/infrastructure/crypto/web-crypto";
import { FakeHasher, InMemoryUserRepository, RecordingAuditLogger } from "./fakes";
import { InMemoryEmailChallengeRepository, RecordingEmailSender } from "./fakes.otp";

/**
 * 用途ごとの送信総量（#236）。
 *
 * ## なぜ 3 つ目の層なのか
 *
 * 既にある 2 つは、**宛先を変えながら送る攻撃で同時に外れる**:
 *
 * - `RateLimitPolicy.email_start` は **IP 単位**。IP を分ければ効かず、
 *   そのうえ Cloudflare の Rate Limiting API は近似で、本番では設定の
 *   数倍が通る（実測で 10 に対して 45 本／ランブック §13.2）
 * - `OtpPolicy.maxResends` は**アドレス単位**。signup は未登録のアドレスへ
 *   送るので、**宛先はいくらでも作れる**
 *
 * 二層あること自体は正しいが、**二層あるから止まる、は成り立っていなかった。**
 * ここで固定するのは「IP にもアドレスにも依らない層が効いていること」である。
 *
 * ## ここで止まると何が起きるかも固定する
 *
 * この層は攻撃者に**「新規登録を 1 時間止める」手段を与える。** だからこそ
 * login と枠を分けてあり（ログインが死ぬと既存利用者が全員締め出される）、
 * 止まったことは監査に出る。その 2 つが崩れていないことまで見る。
 */

const NOW = new Date("2026-10-29T00:00:00.000Z");

/** signup の枠。login（200）はループが重いので、こちらで代表させる。 */
const SIGNUP_CAP = OtpPolicy.globalMaxSends.signup;

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

describe("用途ごとの送信総量", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  /**
   * 宛先を変えながら signup を撃つ。**これが止めたい攻撃そのもの。**
   *
   * アドレスが毎回違うので `maxResends` もクールダウンも効かない
   * （どちらもアドレス単位）。IP の層はここより手前なので、この経路には
   * 現れない。残るのは総量だけである。
   */
  async function blast(times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await ctx.start.execute({ email: `victim${i}@example.test`, purpose: "signup" });
    }
  }

  it("宛先を変えても総量で止まる", async () => {
    await blast(SIGNUP_CAP + 10);

    expect(ctx.emailSender.sent).toHaveLength(SIGNUP_CAP);
  });

  it("止まったことを正直に伝える（#247）", async () => {
    // **黙って成功を装わない。** 以前は正常系と同じ応答を返していて、
    // 画面には「確認コードをお送りしました」が出て**メールは永久に
    // 来なかった。** 利用者は自分の入力か迷惑メールかを探すことになる。
    // レート制限と同じ文言なら、サービス側の事情として読める。
    await blast(SIGNUP_CAP + 1);

    const blocked = await ctx.start.execute({ email: "late@example.test", purpose: "signup" });

    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("unreachable");
    expect(blocked.error.code).toBe("rate_limited");
  });

  it("打ち止め中、登録済みかどうかで応答が変わらない", async () => {
    // **これが正直にできる条件そのものである。** 判定が `shouldSend` の
    // 内側にあると、打ち止め中は「登録済み → 正常系 / 未登録 → 打ち止め」
    // となり、**応答の差からアカウントの有無が読める。** 外に出した以上、
    // ここが成り立たなければ #247 の変更は穴を 1 つ開けただけになる。
    ctx.users.seed(aUser({ email: "taro@example.com" }));
    await blast(SIGNUP_CAP + 1);

    const registered = await ctx.start.execute({
      email: "taro@example.com",
      purpose: "signup",
    });
    const unknown = await ctx.start.execute({
      email: "nobody@example.test",
      purpose: "signup",
    });

    expect(registered).toEqual(unknown);
  });

  it("打ち止めでないときは「送った」とだけ返す", async () => {
    // 正常系まで `rate_limited` に巻き込んでいないこと。**打ち止めの
    // 応答が増えた以上、正常系と見分けが付くことを別に見る。**
    const registered = await ctx.start.execute({
      email: "newcomer@example.test",
      purpose: "signup",
    });

    expect(registered.ok).toBe(true);
  });

  it("signup を尽くしてもログインは送れる", async () => {
    // **ここが枠を分けている理由。** ログインが死ぬと既存の利用者が全員
    // 締め出されるので、攻撃者にとってはそちらのほうが安い目標になる。
    // signup が尽きるのは「新規登録が一時的に止まる」で、被害の質が違う。
    ctx.users.seed(aUser({ email: "taro@example.com" }));
    await blast(SIGNUP_CAP + 5);
    ctx.emailSender.sent.length = 0;

    await ctx.start.execute({ email: "taro@example.com", purpose: "login" });

    expect(ctx.emailSender.sent).toHaveLength(1);
  });

  it("打ち止めを監査ログに残す", async () => {
    // **止まったことに誰も気づかない状態にはしない。** 閾値が低すぎた
    // ことはここでしか分からない（利用者には「コードが届かない」としか
    // 見えず、応答も変えていないので区別がつかない）。
    await blast(SIGNUP_CAP + 1);

    expect(ctx.audit.events).toContainEqual(
      expect.objectContaining({
        event: "otp.start",
        outcome: "failure",
        reason: "global_send_cap",
      }),
    );
  });

  it("窓を抜ければまた送れる", async () => {
    await blast(SIGNUP_CAP + 1);
    expect(ctx.emailSender.sent).toHaveLength(SIGNUP_CAP);

    ctx.clock.advance(OtpPolicy.globalSendWindowMs + 1000);
    await ctx.start.execute({ email: "later@example.test", purpose: "signup" });

    expect(ctx.emailSender.sent).toHaveLength(SIGNUP_CAP + 1);
  });

  it("送られない要求は枠を消費しない", async () => {
    // signup は登録済みのアドレスには送らない。**そこで枠が減るなら、
    // 登録済みアドレスを並べるだけで新規登録を止められる** —— 守ろうと
    // したものが、より安い妨害になる。
    //
    // いまそうならないのは**数え方のおかげ**で、判定の位置ではない。
    // 数えているのは `email_challenges` の行数なので、`create()` を
    // 通らない要求はそもそも勘定に入らない（判定を `shouldSend` の外へ
    // 出しても、このテストは通る。実際に動かして確かめた）。
    //
    // **だからここが守っているのは「行を数えること」そのものである。**
    // 要求数を数える実装に変えた瞬間、ここが最初に壊れる。
    ctx.users.seed(aUser({ email: "taro@example.com" }));
    for (let i = 0; i < SIGNUP_CAP + 10; i += 1) {
      await ctx.start.execute({ email: "taro@example.com", purpose: "signup" });
    }
    expect(ctx.emailSender.sent, "登録済みアドレスへの signup は送られない").toHaveLength(0);

    await ctx.start.execute({ email: "newcomer@example.test", purpose: "signup" });

    expect(ctx.emailSender.sent, "枠が消費されている").toHaveLength(1);
  });
});

describe("保持期限との相互作用（#43 / #236）", () => {
  it("総量の窓は保持期間を超えてはならない", () => {
    // `maxResends` の窓とまったく同じ制約。数える材料が
    // email_challenges の行である以上、掃除された行は数えられない。
    // 窓のほうが長いと、**待つだけで総量を回り込める。**
    expect(OtpPolicy.globalSendWindowMs).toBeLessThanOrEqual(RetentionPolicy.email_challenges);
  });

  it("すべての用途に枠がある", () => {
    // 用途を足したときに、**ここが欠けても型は通る**（Record の型注釈は
    // use case 側にあるので実際には止まるが、値だけを見て足す人がいる）。
    // 枠の無い用途は無制限になるので、値そのものを見ておく。
    for (const purpose of ["login", "signup", "verify_email", "recovery"] as const) {
      expect(OtpPolicy.globalMaxSends[purpose]).toBeGreaterThan(0);
    }
  });
});
