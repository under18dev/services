import type { Session } from "../../domain/entities/session";
import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { TokenHasher } from "../ports/crypto.port";
import type { SessionRepository } from "../ports/session.repository";
import type { UserRepository } from "../ports/user.repository";
import { settleSideEffects } from "./side-effects";
import { ok, type UseCaseResult } from "./types";

export type GetSessionCommand = {
  readonly sessionToken: string;
};

export type GetSessionOutput = {
  readonly session: Session;
  readonly userId: string;
} | null;

export type GetSessionDeps = {
  readonly sessions: SessionRepository;
  readonly users: UserRepository;
  readonly hasher: TokenHasher;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * セッショントークンを検証して、使えるセッションなら返す。
 *
 * 「無効なトークン」「期限切れ」「失効済み」「ユーザーが停止中」はすべて
 * null に畳み込む。理由を呼び出し元へ返すと、トークンの存在有無を
 * 推測させる材料になるため（仕様書 9）。
 */
export class GetSessionUseCase {
  constructor(private readonly deps: GetSessionDeps) {}

  async execute(command: GetSessionCommand): Promise<UseCaseResult<GetSessionOutput>> {
    const tokenHash = await this.deps.hasher.hash(command.sessionToken);
    const session = await this.deps.sessions.findByTokenHash(tokenHash);
    if (session === null) return ok(null);

    const now = this.deps.clock.now();
    if (!session.isUsableAt(now)) {
      await this.deps.audit.record({
        event: "session.rejected",
        userId: session.userId,
        outcome: "failure",
        reason: session.isRevoked ? "revoked" : "expired",
      });
      return ok(null);
    }

    // 停止・削除されたユーザーのセッションは、期限内でも通さない。
    // セッションを引いてからでないと userId が分からないので、ここは直列。
    const user = await this.deps.users.findById(session.userId);
    if (user === null || !user.isActive) {
      await this.deps.audit.record({
        event: "session.rejected",
        userId: session.userId,
        outcome: "failure",
        reason: "user_not_active",
      });
      return ok(null);
    }

    // 最終アクセスの更新はセッション一覧の表示用。失敗しても認証は成立させる。
    await settleSideEffects("session.touch", this.deps.sessions.touch(session.id, now));

    return ok({ session, userId: session.userId });
  }
}
