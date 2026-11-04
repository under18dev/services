import type { AuditLogger } from "../ports/audit-log.port";
import type { OAuthClientRepository } from "../ports/oauth-client.repository";
import type { UserRepository } from "../ports/user.repository";
import { requireExistingActor } from "./admin-access";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type DelegatedSetOAuthClientOwnerCommand = {
  readonly actorUserId: string;
  readonly clientId: string;
  /** `null` で持ち主を外す。 */
  readonly ownerUserId: string | null;
};

export type DelegatedSetOAuthClientOwnerDeps = {
  readonly users: UserRepository;
  readonly clients: OAuthClientRepository;
  readonly audit: AuditLogger;
};

/**
 * OAuth クライアントの持ち主を設定・変更する（admin-worker 経由、#441）。
 *
 * ## `ownerUserId` の実在は auth-worker が確かめる
 *
 * **admin-worker の申告をそのまま信じない。** `users` を持つのは
 * auth-worker だけなので、ここで `UserRepository.findById` を引く
 * （決定 12 と同じ筋——`caller` の自己申告を認可に使わないのと同じ理由で、
 * admin-worker が「存在する」と言うだけでは信じない）。
 *
 * **`null` のときは確かめない。** 持ち主を外す操作に実在確認は要らない。
 *
 * ## 一方向の遷移ではない
 *
 * `disable` / `release` と違い、何度でも変えられる。冪等性のための
 * WHERE 句は要らない——同じ値を渡しても、別の値に変えても、どちらも
 * 正当な呼び出しである。失効済みのクライアントの持ち主も変えられる
 * （記録の訂正は止める理由にならない）。
 *
 * ## 監査: 新しい名前が要る
 *
 * `oauth.client.owner_changed` を新設する（`audit-log.port.ts` の冒頭を
 * 参照）。`actorUserId` を `userId` として記録する——`oauth.client.created`
 * / `disabled` と同じで、操作の対象は利用者ではなくクライアントなので、
 * `userId` には実行者が入る。前後の値は `metadata` へ。
 */
export class DelegatedSetOAuthClientOwnerUseCase {
  constructor(private readonly deps: DelegatedSetOAuthClientOwnerDeps) {}

  async execute(command: DelegatedSetOAuthClientOwnerCommand): Promise<UseCaseResult<null>> {
    const actor = await requireExistingActor(this.deps, command.actorUserId);
    if (!actor.ok) return actor;
    const actorUserId = actor.value.userId;

    if (command.ownerUserId !== null) {
      const owner = await this.deps.users.findById(command.ownerUserId);
      if (owner === null) {
        await this.record(actorUserId, "failure", command.clientId, null, {
          reason: "owner_does_not_exist",
        });
        return err("invalid_input", "ownerUserId does not exist");
      }
    }

    const target = await this.deps.clients.findByClientId(command.clientId);
    const previousOwnerUserId = target?.ownerUserId ?? null;

    const changed = await this.deps.clients.setOwner(command.clientId, command.ownerUserId);
    if (!changed) {
      await this.record(actorUserId, "failure", command.clientId, previousOwnerUserId, {
        reason: "client_not_found",
      });
      return err("not_found", "client not found");
    }

    await this.record(actorUserId, "success", command.clientId, previousOwnerUserId, {
      newOwnerUserId: command.ownerUserId,
    });

    return ok(null);
  }

  private async record(
    actorUserId: string,
    outcome: "success" | "failure",
    clientId: string,
    previousOwnerUserId: string | null,
    extra: { reason?: string; newOwnerUserId?: string | null },
  ): Promise<void> {
    const { reason, ...metadataExtra } = extra;
    await settleSideEffects(
      "oauth.client.owner_changed",
      this.deps.audit.record({
        event: "oauth.client.owner_changed",
        userId: actorUserId,
        outcome,
        ...(reason === undefined ? {} : { reason }),
        metadata: { clientId, previousOwnerUserId, ...metadataExtra },
      }),
    );
  }
}
