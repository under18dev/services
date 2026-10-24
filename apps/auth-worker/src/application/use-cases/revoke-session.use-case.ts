import type { AuditLogger } from "../ports/audit-log.port";
import type { AuthorizationCodeRepository } from "../ports/authorization-code.repository";
import type { Clock } from "../ports/clock.port";
import type { SessionRepository } from "../ports/session.repository";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";
import type { GetSessionUseCase } from "./get-session.use-case";

export type RevokeSessionCommand = {
  readonly sessionToken: string;
  readonly targetSessionId: string;
};

export type RevokeSessionDeps = {
  readonly getSession: GetSessionUseCase;
  readonly sessions: SessionRepository;
  /** 失効させたセッション中の未交換コードを連鎖失効させるため（#15）。 */
  readonly codes: AuthorizationCodeRepository;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * 自分のセッションを 1 つ失効させる。
 *
 * 所有者チェックが本体。targetSessionId は呼び出し元が自由に指定できるため、
 * 操作者のセッションから導いた userId と一致することを必ず確かめる。
 */
export class RevokeSessionUseCase {
  constructor(private readonly deps: RevokeSessionDeps) {}

  async execute(
    command: RevokeSessionCommand,
  ): Promise<UseCaseResult<{ revoked: boolean; self: boolean }>> {
    const auth = await this.deps.getSession.execute({ sessionToken: command.sessionToken });
    if (!auth.ok) return auth;
    if (auth.value === null) return err("unauthenticated", "session is not valid");

    const { userId } = auth.value;
    const target = await this.deps.sessions.findById(command.targetSessionId);

    // 他人のセッションと存在しないセッションを同じ応答にする。
    // 区別して返すと、セッション ID の実在を確かめる手段になる。
    if (target === null || target.userId !== userId) {
      await settleSideEffects(
        "session.revoke",
        this.deps.audit.record({
          event: "session.revoke",
          userId,
          outcome: "failure",
          reason: "not_found_or_not_owned",
        }),
      );
      return err("not_found", "session not found");
    }

    // 操作者自身のセッションを消したのかどうか。Presentation 側が
    // 「Cookie も落とすべきか」を判断するのに要る。
    const self = target.id === auth.value.session.id;

    const now = this.deps.clock.now();
    const revoked = await this.deps.sessions.revoke(target.id, now);
    // セッションを切ったのに、そのセッション中に発行された未交換の認可コードが
    // 60 秒間生き残ると、「この端末からの認可を止めた」という操作の意味が
    // 欠ける。ログアウトと同じ扱いにする（#15）。
    await this.deps.codes.revokeUnconsumedBySession(target.id, now);
    await settleSideEffects(
      "session.revoke",
      this.deps.audit.record({
        event: "session.revoke",
        userId,
        outcome: "success",
        metadata: { self },
      }),
    );
    return ok({ revoked, self });
  }
}
