import { validateAppUrl } from "../../domain/services/app-url";
import type { AuditLogger } from "../ports/audit-log.port";
import type { OAuthClientRepository } from "../ports/oauth-client.repository";
import type { UserRepository } from "../ports/user.repository";
import { requireExistingActor } from "./admin-access";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type DelegatedSetOAuthClientAppUrlCommand = {
  readonly actorUserId: string;
  readonly clientId: string;
  /** `null` で外す。 */
  readonly appUrl: string | null;
};

export type DelegatedSetOAuthClientAppUrlDeps = {
  readonly users: UserRepository;
  readonly clients: OAuthClientRepository;
  readonly audit: AuditLogger;
};

/**
 * OAuth クライアントの表示用 URL（`app_url`）を設定・変更する
 * （admin-worker 経由、#457）。`DelegatedSetOAuthClientOwnerUseCase`
 * （#441）と同じ形。
 *
 * ## 実在確認ではなく形式検証
 *
 * `ownerUserId` と違い、`appUrl` は他テーブルの行を指さないので
 * 「実在するか」は問えない。代わりに `domain/services/app-url.ts` で
 * 形式（`https:` のみ・資格情報を含まない）を確かめる。
 * **`redirect_uri` との突き合わせはしない** —— ここでは呼び出し側
 * （admin-worker の画面）が入力した値をそのまま信じる。
 *
 * ## 一方向の遷移ではない
 *
 * `setOwner` と同じく、何度でも変えられる。冪等性のための WHERE 句は
 * 要らない。失効済みのクライアントの URL も変えられる。
 *
 * ## 監査: 新しい名前にするが `security` 区分にはしない
 *
 * `oauth.client.app_url_changed` を新設する。`owner_changed` と違い、
 * 認可にもアクセス制御にも効かない表示用の情報なので `standard`
 * （`audit-log.port.ts` を参照）。
 */
export class DelegatedSetOAuthClientAppUrlUseCase {
  constructor(private readonly deps: DelegatedSetOAuthClientAppUrlDeps) {}

  async execute(command: DelegatedSetOAuthClientAppUrlCommand): Promise<UseCaseResult<null>> {
    const actor = await requireExistingActor(this.deps, command.actorUserId);
    if (!actor.ok) return actor;
    const actorUserId = actor.value.userId;

    if (command.appUrl !== null) {
      const validation = validateAppUrl(command.appUrl);
      if (!validation.ok) {
        await this.record(actorUserId, "failure", command.clientId, null, {
          reason: `invalid_app_url:${validation.reason}`,
        });
        return err("invalid_input", "appUrl is not a usable https URL");
      }
    }

    const target = await this.deps.clients.findByClientId(command.clientId);
    const previousAppUrl = target?.appUrl ?? null;

    const changed = await this.deps.clients.setAppUrl(command.clientId, command.appUrl);
    if (!changed) {
      await this.record(actorUserId, "failure", command.clientId, previousAppUrl, {
        reason: "client_not_found",
      });
      return err("not_found", "client not found");
    }

    await this.record(actorUserId, "success", command.clientId, previousAppUrl, {
      newAppUrl: command.appUrl,
    });

    return ok(null);
  }

  private async record(
    actorUserId: string,
    outcome: "success" | "failure",
    clientId: string,
    previousAppUrl: string | null,
    extra: { reason?: string; newAppUrl?: string | null },
  ): Promise<void> {
    const { reason, ...metadataExtra } = extra;
    await settleSideEffects(
      "oauth.client.app_url_changed",
      this.deps.audit.record({
        event: "oauth.client.app_url_changed",
        userId: actorUserId,
        outcome,
        ...(reason === undefined ? {} : { reason }),
        metadata: { clientId, previousAppUrl, ...metadataExtra },
      }),
    );
  }
}
