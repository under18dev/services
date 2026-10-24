import type { OAuthClient } from "../../domain/entities/oauth-client";
import type { AuditLogger } from "../ports/audit-log.port";
import type { OAuthClientRepository } from "../ports/oauth-client.repository";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type AuthenticateOAuthClientCommand = {
  readonly clientId: string;
  /**
   * 提示された `client_secret`。public クライアントや PKCE のみの要求では null。
   * どのヘッダ／ボディから取り出したか（Basic / POST）は Presentation の関心事。
   */
  readonly clientSecret: string | null;
};

export type AuthenticateOAuthClientDeps = {
  readonly clients: OAuthClientRepository;
  readonly audit: AuditLogger;
};

/**
 * `/oauth/token` でクライアントを認証する（仕様書 5.1）。
 *
 * confidential は `client_secret` で、public は PKCE だけで本人性を担保する。
 * **public クライアントが秘密を提示してきた場合も拒否する。** 受け入れてしまうと
 * 「秘密を知っている＝認証済み」という扱いが public クライアントにも生まれ、
 * クライアント種別によって保証の強さが変わるという前提が崩れる。
 */
export class AuthenticateOAuthClientUseCase {
  constructor(private readonly deps: AuthenticateOAuthClientDeps) {}

  async execute(command: AuthenticateOAuthClientCommand): Promise<UseCaseResult<OAuthClient>> {
    const client = await this.deps.clients.findByClientId(command.clientId);
    if (client === null || client.isDisabled) {
      return this.reject(command.clientId, client === null ? "unknown_client" : "client_disabled");
    }

    if (client.isConfidential) {
      if (command.clientSecret === null) {
        return this.reject(client.clientId, "missing_client_secret");
      }
      // 照合は Repository 内で定時間比較まで行う。ここで平文を保持し続けない。
      const verified = await this.deps.clients.verifySecret(client.clientId, command.clientSecret);
      if (!verified) return this.reject(client.clientId, "invalid_client_secret");
    } else if (command.clientSecret !== null) {
      return this.reject(client.clientId, "secret_presented_by_public_client");
    }

    return ok(client);
  }

  /**
   * 失敗はすべて同じ `invalid_client` に畳む。
   *
   * 「client_id が無い」「秘密が違う」「失効済み」を外から区別できると、
   * 総当たりの効率がそのぶん上がる。理由は監査ログにだけ残す。
   */
  private async reject(clientId: string, reason: string): Promise<UseCaseResult<never>> {
    await settleSideEffects(
      "oauth.client.authenticate",
      this.deps.audit.record({
        event: "oauth.client.authenticate",
        outcome: "failure",
        reason,
        metadata: { clientId },
      }),
    );
    return err("invalid_client", "client authentication failed");
  }
}
