import { EmailAddress, Username, newUserId } from "@u18/domain";
import type { Session } from "../../domain/entities/session";
import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { TokenHasher } from "../ports/crypto.port";
import type { EmailChallengeRepository, OtpPurpose } from "../ports/email-challenge.repository";
import type { UserRepository } from "../ports/user.repository";
import type { IssueSessionUseCase } from "./issue-session.use-case";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type VerifyEmailOtpCommand = {
  readonly email: string;
  readonly code: string;
  readonly purpose: OtpPurpose;
  readonly userAgent: string | null;
  readonly ip: string | null;
};

export type VerifyEmailOtpOutput = {
  readonly session: Session;
  readonly token: string;
  /** 新規登録でユーザーを作った場合に true。 */
  readonly created: boolean;
};

export type VerifyEmailOtpDeps = {
  readonly users: UserRepository;
  readonly challenges: EmailChallengeRepository;
  readonly issueSession: IssueSessionUseCase;
  readonly hasher: TokenHasher;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * メール OTP を検証し、成功したらセッションを発行する。
 *
 * コードの照合・試行回数の加算・消費は Repository が 1 つの原子的な操作で行う
 * （仕様書 7.3）。ここで「読んでから書く」に分解すると、同じコードを並行で
 * 投げることで試行上限を超えられる。
 */
export class VerifyEmailOtpUseCase {
  constructor(private readonly deps: VerifyEmailOtpDeps) {}

  async execute(command: VerifyEmailOtpCommand): Promise<UseCaseResult<VerifyEmailOtpOutput>> {
    const address = EmailAddress.tryCreate(command.email);
    if (address === null) return err("invalid_input", "email address is malformed");

    const result = await this.deps.challenges.consume(
      address.value,
      command.purpose,
      await this.deps.hasher.hash(command.code),
      this.deps.clock.now(),
    );

    if (result.outcome === "exhausted") {
      await this.recordFailure(address.masked, "attempts_exhausted");
      return err("too_many_attempts", "too many attempts");
    }
    if (result.outcome !== "consumed") {
      // 不一致・期限切れ・使用済み・不存在をすべて同じ応答に畳む。
      // 区別すると「このコードは存在した」「このアドレスは登録済み」が漏れる。
      await this.recordFailure(address.masked, result.outcome);
      return err("invalid_code", "verification failed");
    }

    const user =
      command.purpose === "signup"
        ? await this.createUser(address)
        : await this.deps.users.findByEmail(address.value);

    if (user === null) {
      // コードは正しかったが対象ユーザーが居ない。コードは消費済みなので
      // 再利用はされない。失敗として扱う。
      await this.recordFailure(address.masked, "user_missing");
      return err("invalid_code", "verification failed");
    }

    const issued = await this.deps.issueSession.execute({
      userId: user.id,
      authMethod: "email_otp",
      userAgent: command.userAgent,
      ip: command.ip,
    });
    // 発行側のエラーコードをそのまま返さない。`IssueSessionUseCase` は
    // 停止・論理削除されたユーザーに `forbidden` を返すので、そのまま流すと
    // 「コードは正しかったが、このアカウントは凍結されている」が応答から
    // 読み取れてしまう（仕様書 §14.1 決定 7 により、凍結アカウントの行は
    // 残り続ける）。この経路の失敗は全て `invalid_code` に畳む。
    //
    // 現状、凍結アカウント宛には OTP がそもそも送られない（`StartEmailOtpUseCase`
    // の `shouldSend`）ので、ここへ到達するのは start と verify の間で
    // アカウントの状態が変わった場合に限られる。ただし **`shouldSend` の条件を
    // 変えた瞬間にここが列挙の窓口になる**ため、送信側の判断に依存させない。
    // `PasskeyLoginVerifyUseCase` が同じ理由で同じ畳み方をしている。
    if (!issued.ok) {
      await this.recordFailure(address.masked, `issue_session:${issued.error.code}`);
      return err("invalid_code", "verification failed");
    }

    // ログイン経路を通った時点でメールアドレスの到達性は確認できている。
    if (!user.emailVerified) {
      await settleSideEffects(
        "otp.verify.mark_email_verified",
        this.deps.users.markEmailVerified(user.id, address.value),
      );
    }

    return ok({
      session: issued.value.session,
      token: issued.value.token,
      created: command.purpose === "signup",
    });
  }

  /** signup 用のユーザーを作る。username は後から変更できる仮の値。 */
  private async createUser(address: EmailAddress) {
    // 既に居る場合は作らない。consume を通っている＝そのアドレスの
    // 所有者なので、既存アカウントへのログインとして扱って問題ない。
    const existing = await this.deps.users.findByEmail(address.value);
    if (existing !== null) return existing;

    const id = newUserId();
    const username = Username.create(`u${id.slice(4, 14)}`);
    return this.deps.users.create({
      id,
      username: username.value,
      displayName: username.value,
      email: address.value,
      emailVerified: true,
    });
  }

  private async recordFailure(maskedEmail: string, reason: string): Promise<void> {
    await settleSideEffects(
      "otp.verify",
      this.deps.audit.record({
        event: "otp.verify",
        outcome: "failure",
        reason,
        // 生のメールアドレスは監査ログに残さない（仕様書 4.4 / 9）。
        metadata: { email: maskedEmail },
      }),
    );
  }
}
