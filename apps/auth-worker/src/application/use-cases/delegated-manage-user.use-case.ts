import type { AuditEventName, AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { SessionRepository } from "../ports/session.repository";
import type { UserRepository } from "../ports/user.repository";
import { requireExistingActor } from "./admin-access";
import type { SuspendReason } from "./manage-user.use-case";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type DelegatedSuspendUserCommand = {
  readonly actorUserId: string;
  readonly userId: string;
  readonly reason: SuspendReason;
};

export type DelegatedReinstateUserCommand = {
  readonly actorUserId: string;
  readonly userId: string;
};

export type DelegatedRevokeUserSessionsCommand = {
  readonly actorUserId: string;
  readonly userId: string;
};

export type DelegatedManageUserDeps = {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * 利用者の停止・解除・セッションの失効（admin-worker 経由、
 * #390 決定 16 ③）。`ManageUserUseCase` と対になる。
 *
 * ## `ManageUserUseCase` との違いは認可の持ち方だけ
 *
 * - **`requireAdminSession` を呼ばない。** 管理者かどうかの確認は
 *   admin-worker が済ませている（`IdentityAdminDelegatedRpcContract`
 *   の冒頭）
 * - **再認証（`hasFreshAuthentication`）も持たない。** セッションの
 *   「新しさ」という概念自体が無い —— admin-worker が自分のセッションの
 *   新しさをどう扱うかは、こちらの関知するところではない
 * - **`actorUserId` の実在だけ確かめる**（`requireExistingActor`）。
 *   検証ではなく実在確認 —— 詳しい理由は `admin-access.ts` を参照
 *
 * ## それでも残す 2 つ
 *
 * - **自分は止められない**（`conflict`）。止めると解除する人が
 *   居なくなるのは admin-worker 経由でも変わらない
 * - **セッションの失効だけは自分にも許す。** 全端末からログアウトに
 *   あたる操作で、自分に対しても意味がある
 */
export class DelegatedManageUserUseCase {
  constructor(private readonly deps: DelegatedManageUserDeps) {}

  async suspend(
    command: DelegatedSuspendUserCommand,
  ): Promise<UseCaseResult<{ revokedSessions: number }>> {
    const guard = await this.authorize(command.actorUserId, command.userId, { allowSelf: false });
    if (!guard.ok) return guard;

    const changed = await this.deps.users.setStatus(command.userId, {
      from: "active",
      to: "suspended",
    });
    if (!changed) return err("conflict", "user is not active");

    const revokedSessions = await this.deps.sessions.revokeAllForUser(
      command.userId,
      this.deps.clock.now(),
    );

    await this.record("ops.user.suspended", command.actorUserId, command.userId, {
      reason: command.reason,
      revokedSessions,
    });

    return ok({ revokedSessions });
  }

  async reinstate(
    command: DelegatedReinstateUserCommand,
  ): Promise<UseCaseResult<Record<string, never>>> {
    const guard = await this.authorize(command.actorUserId, command.userId, { allowSelf: false });
    if (!guard.ok) return guard;

    const changed = await this.deps.users.setStatus(command.userId, {
      from: "suspended",
      to: "active",
    });
    if (!changed) return err("conflict", "user is not suspended");

    await this.record("ops.user.reinstated", command.actorUserId, command.userId, {});

    return ok({});
  }

  async revokeSessions(
    command: DelegatedRevokeUserSessionsCommand,
  ): Promise<UseCaseResult<{ revokedSessions: number }>> {
    const guard = await this.authorize(command.actorUserId, command.userId, { allowSelf: true });
    if (!guard.ok) return guard;

    const revokedSessions = await this.deps.sessions.revokeAllForUser(
      command.userId,
      this.deps.clock.now(),
    );

    await this.record("ops.user.sessions_revoked", command.actorUserId, command.userId, {
      revokedSessions,
    });

    return ok({ revokedSessions });
  }

  /**
   * 3 つに共通する関門。**`actorUserId` の実在 → 自分でない、の順。**
   * `ManageUserUseCase.authorize` から「管理者か」「新しいか」を抜いた形
   * （どちらも admin-worker 側の責務になったため）。
   */
  private async authorize(
    actorUserId: string,
    targetUserId: string,
    options: { readonly allowSelf: boolean },
  ): Promise<UseCaseResult<{ actorId: string }>> {
    const actor = await requireExistingActor(this.deps, actorUserId);
    if (!actor.ok) return actor;

    if (!options.allowSelf && actorUserId === targetUserId) {
      return err("conflict", "cannot apply this operation to yourself");
    }

    return ok({ actorId: actor.value.userId });
  }

  private async record(
    event: AuditEventName,
    actorId: string,
    targetUserId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await settleSideEffects(
      event,
      this.deps.audit.record({
        event,
        userId: targetUserId,
        outcome: "success",
        metadata: { ...metadata, actorUserId: actorId },
      }),
    );
  }
}
