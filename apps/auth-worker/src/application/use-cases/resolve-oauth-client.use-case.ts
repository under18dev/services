import type { OAuthClient } from "../../domain/entities/oauth-client";
import type { AuditLogger } from "../ports/audit-log.port";
import type { OAuthClientRepository } from "../ports/oauth-client.repository";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type ResolveOAuthClientCommand = {
  readonly clientId: string;
  /** 認可要求に載っていた `redirect_uri`。省略は許さない。 */
  readonly redirectUri: string;
};

export type ResolveOAuthClientOutput = {
  readonly client: OAuthClient;
  /** 検証済みの宛先。以降はこの値だけを使い、入力文字列を再利用しない。 */
  readonly redirectUri: string;
};

export type ResolveOAuthClientDeps = {
  readonly clients: OAuthClientRepository;
  readonly audit: AuditLogger;
};

/**
 * `/oauth/authorize` の入口で、クライアントと宛先を確定させる。
 *
 * **このユースケースが成功するまで、リダイレクトを一切行ってはならない。**
 * `client_id` が未知・失効、あるいは `redirect_uri` が未登録の場合、
 * エラーを `redirect_uri` へ返すとオープンリダイレクトそのものになる
 * （RFC 6749 §4.1.2.1）。呼び出し側は失敗時に自前のエラー画面を出すこと。
 */
export class ResolveOAuthClientUseCase {
  constructor(private readonly deps: ResolveOAuthClientDeps) {}

  async execute(
    command: ResolveOAuthClientCommand,
  ): Promise<UseCaseResult<ResolveOAuthClientOutput>> {
    const client = await this.deps.clients.findByClientId(command.clientId);

    // 「そんな client_id は無い」と「失効済み」を同じ `invalid_client` に畳む。
    // 区別して返すと、client_id の実在確認に使える（RevokeSessionUseCase が
    // 他人のセッションと存在しないセッションを畳むのと同じ理由）。
    // 運用で必要な区別は監査ログの reason に残す。
    if (client === null || client.isDisabled) {
      await settleSideEffects(
        "oauth.client.resolve",
        this.deps.audit.record({
          event: "oauth.client.resolve",
          outcome: "failure",
          reason: client === null ? "unknown_client" : "client_disabled",
          metadata: { clientId: command.clientId },
        }),
      );
      return err("invalid_client", "client is not available");
    }

    if (!client.matchesRedirectUri(command.redirectUri)) {
      await settleSideEffects(
        "oauth.client.resolve",
        this.deps.audit.record({
          event: "oauth.client.resolve",
          outcome: "failure",
          reason: "redirect_uri_mismatch",
          // 届いた redirect_uri は残さない。攻撃者が任意の文字列を
          // 監査ログへ書き込める経路になる。どのクライアント宛だったかで足りる。
          metadata: { clientId: client.clientId },
        }),
      );
      return err("invalid_redirect_uri", "redirect_uri is not registered for this client");
    }

    return ok({ client, redirectUri: command.redirectUri });
  }
}
