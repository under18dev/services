import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { TokenHasher } from "../ports/crypto.port";
import type { SessionRepository } from "../ports/session.repository";
import { settleSideEffects } from "./side-effects";
import { ok, type UseCaseResult } from "./types";

export type LogoutCommand = {
  readonly sessionToken: string;
  /** true なら同じユーザーの全セッションを失効させる（別デバイス含む）。 */
  readonly allDevices: boolean;
};

export type LogoutOutput = {
  /** 失効させたセッション数。0 でも成功扱い。 */
  readonly revokedCount: number;
};

export type LogoutDeps = {
  readonly sessions: SessionRepository;
  readonly hasher: TokenHasher;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * ログアウト。
 *
 * **無効なトークンでも成功を返す**（冪等）。
 * 「そのセッションは存在しなかった」と教えると、トークンの実在を確かめる
 * 手段になる。利用者から見ればどちらもログアウト済みで違いはない。
 */
export class LogoutUseCase {
  constructor(private readonly deps: LogoutDeps) {}

  async execute(command: LogoutCommand): Promise<UseCaseResult<LogoutOutput>> {
    const tokenHash = await this.deps.hasher.hash(command.sessionToken);
    const session = await this.deps.sessions.findByTokenHash(tokenHash);
    if (session === null) return ok({ revokedCount: 0 });

    const now = this.deps.clock.now();

    if (command.allDevices) {
      const revokedCount = await this.deps.sessions.revokeAllForUser(session.userId, now);
      await settleSideEffects(
        "session.logout",
        this.deps.audit.record({
          event: "session.logout",
          userId: session.userId,
          outcome: "success",
          metadata: { allDevices: true, revokedCount },
        }),
      );
      return ok({ revokedCount });
    }

    const revoked = await this.deps.sessions.revoke(session.id, now);
    await settleSideEffects(
      "session.logout",
      this.deps.audit.record({
        event: "session.logout",
        userId: session.userId,
        outcome: "success",
        metadata: { allDevices: false, sessionId: session.id },
      }),
    );
    return ok({ revokedCount: revoked ? 1 : 0 });
  }
}
