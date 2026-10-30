import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { OAuthClientRepository } from "../ports/oauth-client.repository";
import type { UserRepository } from "../ports/user.repository";
import { requireExistingActor } from "./admin-access";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type DelegatedDisableOAuthClientCommand = {
  readonly actorUserId: string;
  readonly clientId: string;
};

export type DelegatedDisableOAuthClientOutput = {
  readonly disabled: boolean;
};

export type DelegatedDisableOAuthClientDeps = {
  readonly users: UserRepository;
  readonly clients: OAuthClientRepository;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * OAuth クライアントを失効させる（admin-worker 経由、#390 決定 16 ③）。
 * `DisableOAuthClientUseCase` と対になる。違いは認可の持ち方だけ
 * （`DelegatedCreateOAuthClientUseCase` の JSDoc を参照）。
 *
 * **一次パーティは止められない判断は変えない。** `u18-dashboard` を
 * admin-worker 経由で止められると、u18 全サービスのログインが落ちる
 * ことに変わりはない。
 */
export class DelegatedDisableOAuthClientUseCase {
  constructor(private readonly deps: DelegatedDisableOAuthClientDeps) {}

  async execute(
    command: DelegatedDisableOAuthClientCommand,
  ): Promise<UseCaseResult<DelegatedDisableOAuthClientOutput>> {
    const actor = await requireExistingActor(this.deps, command.actorUserId);
    if (!actor.ok) return actor;
    const actorUserId = actor.value.userId;

    const now = this.deps.clock.now();

    const target = await this.deps.clients.findByClientId(command.clientId);
    if (target !== null && target.isFirstParty) {
      await this.record(actorUserId, "failure", command.clientId, "first_party");
      return err(
        "conflict",
        "first-party clients can only be disabled with scripts/oauth-client.mjs",
      );
    }

    const disabled = await this.deps.clients.disable(command.clientId, now);

    await this.record(
      actorUserId,
      disabled ? "success" : "failure",
      command.clientId,
      disabled ? undefined : "already_disabled_or_unknown",
    );

    return ok({ disabled });
  }

  private async record(
    actorUserId: string,
    outcome: "success" | "failure",
    clientId: string,
    reason?: string,
  ): Promise<void> {
    await settleSideEffects(
      "oauth.client.disabled",
      this.deps.audit.record({
        event: "oauth.client.disabled",
        userId: actorUserId,
        outcome,
        ...(reason === undefined ? {} : { reason }),
        metadata: { clientId },
      }),
    );
  }
}
