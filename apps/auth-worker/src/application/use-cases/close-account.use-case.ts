import { hasFreshAuthentication } from "../../domain/services/reauthentication";
import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { SessionRepository } from "../ports/session.repository";
import type { UserRepository } from "../ports/user.repository";
import type { GetSessionUseCase } from "./get-session.use-case";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type CloseAccountCommand = {
  readonly sessionToken: string;
};

export type CloseAccountOutput = {
  /** 今回の操作で閉じたか。既に閉じていれば `false`。 */
  readonly closed: boolean;
  /** 失効させたセッションの本数。利用者への案内に使う。 */
  readonly revokedSessions: number;
};

export type CloseAccountDeps = {
  readonly getSession: GetSessionUseCase;
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * 本人が自分のアカウントを閉じる（#318 / ランブック §11.7）。
 *
 * ## `suspended` にする。`deleted` にはしない
 *
 * `deleted` は**個人情報が落ちている**ことを指す名前である（§11.6 の表）。
 * 落とさずに立てると `purgeUserSql` の `status <> 'deleted'` に弾かれ、
 * **管理者が二度と落とせなくなる。** しかも `returning` が 0 行を返すので、
 * 運用者からは「既に落とした」と区別が付かない。
 *
 * **BAN と同じ状態になるので、理由は `audit_logs` が持つ**
 * （`account.closed`）。`status` に理由を持たせない。
 *
 * ## 個人情報はここでは落とさない
 *
 * 2026-10-28 の方針は「管理者が任意で削除できるようにしながらも、一応
 * その操作があるまでは残す」である。**本人の操作で落とす話は決まって
 * いない**ので、ここでは落とさない。落とすのは §11.6（#265）。
 *
 * **その結果、退会した人は同じアドレスで再登録できない** ——
 * `primary_email` が残って一意制約で弾かれる。管理者が §11.6 を回すまで
 * そうである。**利用者への案内でここを隠さないこと。**
 *
 * ## 再認証を要求する
 *
 * `DeletePasskeyUseCase` と同じ `hasFreshAuthentication` を使う。
 * **Cookie を 1 枚持っているだけの相手に通させない** —— 置き忘れた端末で
 * 他人がアカウントを閉じられる形にしない。
 *
 * **再認証の経路を新しく作らない。** この実装はログインが必ず新しい
 * セッションを発行するので（`IssueSessionUseCase`）、パスキー署名でも
 * メール OTP でも `createdAt` が進む。利用者の手順は「ログインし直して
 * からもう一度」になる。別経路を足すと、**同じ判断が 2 箇所**になる。
 */
export class CloseAccountUseCase {
  constructor(private readonly deps: CloseAccountDeps) {}

  async execute(command: CloseAccountCommand): Promise<UseCaseResult<CloseAccountOutput>> {
    const auth = await this.deps.getSession.execute({ sessionToken: command.sessionToken });
    if (!auth.ok) return auth;
    if (auth.value === null) return err("unauthenticated", "session is not valid");

    const { session, userId } = auth.value;
    const now = this.deps.clock.now();

    if (!hasFreshAuthentication(session, now)) {
      await this.record(userId, "failure", { reason: "stale_authentication" });
      return err("reauthentication_required", "recent authentication is required");
    }

    // **閉じるのが先、セッションを切るのが後。** 逆にすると、失効だけが
    // 通って状態が `active` のままという中途半端な結果になりうる。
    // この順なら、失敗しても「閉じたのにセッションが残っている」で済み、
    // ログインはもう通らない（`IssueSessionUseCase` が `isActive` を見る）。
    const closed = await this.deps.users.closeAccount(userId);
    if (!closed) {
      // 既に `active` ではない。二重の退会か、先に BAN されている。
      // **BAN を退会の記録で塗り替えない**（`closeAccount` が `active` に
      // 限っている理由）。
      await this.record(userId, "failure", { reason: "not_active" });
      return err("conflict", "account is not active");
    }

    const revokedSessions = await this.deps.sessions.revokeAllForUser(userId, now);

    await this.record(userId, "success", {
      // **何を落としていないかを記録に残す。** 後から「削除したのに残って
      // いる」と見える状態なので、閉じただけであることが読めなければ
      // ならない（§11.7 の応対原則）。
      metadata: { status: "suspended", personalDataRetained: true, revokedSessions },
    });

    return ok({ closed, revokedSessions });
  }

  private async record(
    userId: string,
    outcome: "success" | "failure",
    extra: { reason?: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    await settleSideEffects(
      "account.closed",
      this.deps.audit.record({ event: "account.closed", userId, outcome, ...extra }),
    );
  }
}
