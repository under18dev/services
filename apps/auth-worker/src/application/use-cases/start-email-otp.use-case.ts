import { EmailAddress, newId } from "@u18/domain";
import { OtpPolicy, TokenLifetime, expiresAt } from "../../domain/services/token-lifetime";
import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { RandomTokenGenerator, TokenHasher } from "../ports/crypto.port";
import type { EmailChallengeRepository, OtpPurpose } from "../ports/email-challenge.repository";
import { EmailSendError } from "../ports/email-sender.port";
import type { EmailSender } from "../ports/email-sender.port";
import type { UserRepository } from "../ports/user.repository";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type StartEmailOtpCommand = {
  readonly email: string;
  readonly purpose: OtpPurpose;
};

export type StartEmailOtpOutput = {
  /**
   * 次に再送できるまでの秒数。
   *
   * 「送った / 送っていない」は返さない。アカウントの存在を漏らすため。
   */
  readonly retryAfterSeconds: number;
};

export type StartEmailOtpDeps = {
  readonly users: UserRepository;
  readonly challenges: EmailChallengeRepository;
  readonly email: EmailSender;
  readonly hasher: TokenHasher;
  readonly tokens: RandomTokenGenerator;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * メール OTP を開始する。
 *
 * **アカウントの有無で応答を変えない。** 未登録のアドレスでも同じ形・
 * 同じ所要時間で成功を返す。ここで差をつけると、このエンドポイントが
 * 「このメールアドレスは u18 に登録されているか」を調べる道具になる
 * （仕様書 9 Abuse / Privacy）。未成年の利用者を想定しているので、
 * 在籍の推測そのものを避けたい。
 */
export class StartEmailOtpUseCase {
  constructor(private readonly deps: StartEmailOtpDeps) {}

  async execute(command: StartEmailOtpCommand): Promise<UseCaseResult<StartEmailOtpOutput>> {
    const address = EmailAddress.tryCreate(command.email);
    // 形式不正だけは返す。送信先として成立しておらず、
    // アカウントの有無とは無関係な情報なので漏洩にならない。
    if (address === null) return err("invalid_input", "email address is malformed");

    const now = this.deps.clock.now();
    const cooldownSeconds = Math.ceil(OtpPolicy.resendCooldownMs / 1000);

    // 直近の送信から間が空いていなければ、新しいコードを出さない。
    const active = await this.deps.challenges.findActive(address.value, command.purpose, now);
    if (active?.lastSentAt != null) {
      const elapsed = now.getTime() - active.lastSentAt.getTime();
      if (elapsed < OtpPolicy.resendCooldownMs) {
        return ok({
          retryAfterSeconds: Math.ceil((OtpPolicy.resendCooldownMs - elapsed) / 1000),
        });
      }
    }

    // 再送上限。**`active` の有無に依らず必ず確かめる。**
    //
    // 以前はこの判定がクールダウンと同じ `if (active != null)` の中にあり、
    // しかも `active.resendCount` を見ていた。送信のたびに新しい行を作る以上
    // カウンタは常に 0 で、判定は一度も真にならなかった。OTP の寿命は 5 分
    // なので、5 分待てば `active` 自体が消えて上限判定ごと素通りもした。
    // 結果、60 秒ごとに無制限にメールを送れた（#88）。
    //
    // 窓の中に作られた行数がそのまま送信回数になる。最初の 1 通は再送では
    // ないので、`maxResends` を**超えた**ときに止める。
    const sentInWindow = await this.deps.challenges.countSentSince(
      address.value,
      command.purpose,
      new Date(now.getTime() - OtpPolicy.resendWindowMs),
    );
    if (sentInWindow > OtpPolicy.maxResends) {
      // 上限に達しても応答は変えない。打ち止めであることを伝えると
      // 「このアドレスは実在する」と分かってしまう。下の正常系と
      // **同じ値**を返していることに注意（形も中身も変えないこと）。
      await settleSideEffects(
        "otp.start",
        this.deps.audit.record({
          event: "otp.start",
          outcome: "failure",
          reason: "resend_limit",
        }),
      );
      return ok({ retryAfterSeconds: cooldownSeconds });
    }

    const user = await this.deps.users.findByEmail(address.value);

    // 送信するのは、そのアドレスで本当にログインできる場合だけ。
    // それ以外でも応答は同じにする。
    const shouldSend = command.purpose === "signup" ? user === null : user?.isActive === true;

    if (shouldSend) {
      const code = this.deps.tokens.generateNumericCode(OtpPolicy.codeLength);

      // 新しいコードを出す前に古いものを潰す。残しておくと、
      // 再送のたびに有効なコードが増えて総当たりが楽になる。
      await this.deps.challenges.invalidateActive(address.value, command.purpose, now);

      await this.deps.challenges.create({
        id: newId("emc"),
        userId: user?.id ?? null,
        email: address.value,
        codeHash: await this.deps.hasher.hash(code),
        purpose: command.purpose,
        expiresAt: expiresAt(now, TokenLifetime.emailOtpMs),
        maxAttempts: OtpPolicy.maxAttempts,
        sentAt: now,
      });

      // **送信の結果を待ってから監査を書く。**
      //
      // 以前はここで送信と監査記録を settleSideEffects に**並べて**渡して
      // いた。allSettled なので送信の失敗が監査側に伝わらず、本番で
      // E_RECIPIENT_NOT_ALLOWED が出続けていたのに監査ログは success の
      // ままだった（#141）。wrangler tail を張って初めて分かった。
      //
      // /health はメール送信を見ない（#53 の判断としてそれは正しい）ので、
      // 監査ログが success と書いたら気づく手段が他に無い。
      const failure = await this.send(address.value, code, command.purpose);

      await settleSideEffects(
        "otp.start",
        this.deps.audit.record({
          event: "otp.start",
          userId: user?.id,
          // 送信できなかったものを「送った」と記録しない。
          outcome: failure === null ? "success" : "failure",
          // プロバイダのエラーコード。**外へは返さない**（仕様書 §9）。
          // 調査では「どのアドレスか」より「何が起きているか」が先に要る。
          reason: failure ?? undefined,
          metadata: { purpose: command.purpose },
        }),
      );
    } else {
      await settleSideEffects(
        "otp.start",
        this.deps.audit.record({
          event: "otp.start",
          outcome: "failure",
          reason: "no_eligible_account",
          metadata: { purpose: command.purpose },
        }),
      );
    }

    return ok({ retryAfterSeconds: cooldownSeconds });
  }

  /**
   * OTP を送る。失敗したらプロバイダのエラーコードを返し、成功なら `null`。
   *
   * **例外をここで止めるのが肝。** 送信失敗で 500 を返すと「送信を試みた
   * ＝そのアドレスにアカウントがある」と分かってしまう（仕様書 §9）。
   * 応答は成功時とまったく同じにしたうえで、起きたことは監査ログへ残す。
   */
  private async send(to: string, code: string, purpose: OtpPurpose): Promise<string | null> {
    try {
      await this.deps.email.sendOtp({
        to,
        code,
        purpose,
        expiresInMinutes: Math.round(TokenLifetime.emailOtpMs / 60_000),
      });
      return null;
    } catch (error) {
      // Port の契約どおり EmailSendError が来る想定だが、別の例外（ネットワーク
      // 層の throw など）でも握り潰す。ここから先へ投げると応答が変わる。
      return error instanceof EmailSendError ? error.code : "unknown";
    }
  }
}
