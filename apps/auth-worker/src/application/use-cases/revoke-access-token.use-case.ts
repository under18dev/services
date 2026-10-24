import type { OAuthClient } from "../../domain/entities/oauth-client";
import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { TokenHasher } from "../ports/crypto.port";
import type { OAuthTokenRepository } from "../ports/oauth-token.repository";
import { settleSideEffects } from "./side-effects";
import { ok, type UseCaseResult } from "./types";

export type RevokeAccessTokenCommand = {
  /** 認証済みのクライアント。`AuthenticateOAuthClientUseCase` の結果を渡すこと。 */
  readonly client: OAuthClient;
  /** 失効させたい**平文**トークン。 */
  readonly token: string;
  /** RFC 7009 §2.1 の `token_type_hint`。任意。 */
  readonly tokenTypeHint: string | null;
};

export type RevokeAccessTokenOutput = {
  /** 実際に `revoked_at` を立てたか。監査ログと戻り値の整合を見るためだけに使う。 */
  readonly revoked: boolean;
};

export type RevokeAccessTokenDeps = {
  readonly tokens: OAuthTokenRepository;
  readonly hasher: TokenHasher;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * `/oauth/revoke`（RFC 7009、#17）。
 *
 * ## 常に成功する UseCase
 *
 * 戻り値の `UseCaseResult` は `ok` 以外にならない。失敗を値で返す型に
 * 乗せておきながら失敗しないのは奇妙に見えるが、これは RFC 7009 §2.2 の
 * 要求そのものである——「無効なトークンの失効要求は成功として扱え」。
 * クライアント認証だけは Presentation 層で先に済ませてあり、そこを抜けた
 * 要求に対してこの先で 4xx を返す道は 1 本も無い。
 *
 * 理由は単純で、**失効要求の応答はトークンの実在を測る物差しになってはならない**
 * から。404 を返す実装は「このランダム文字列は発行済みか」を 1 要求につき
 * 1 ビット教える oracle になる。403（他人のトークン）はもっと悪く、
 * 「実在し、かつ別のクライアントのものだ」まで教える。
 *
 * ## 他人のトークンを失効させない
 *
 * 提示されたトークンが認証済みクライアントのものでなければ、**失効させずに**
 * 成功を返す。これを怠ると、クライアントを 1 つ登録するだけで、総当たりで
 * 当てた他社のトークンを片端から無効化できる——認証基盤が DoS の道具になる。
 *
 * 比較は内部 ID（`oauth_clients.id`）で行う。`audience` に入っている公開
 * `client_id` のほうが直感的だが、あちらは発行時の値のコピーで、
 * クライアントの `client_id` を改名すると過去の行とずれる。所有関係の判定は
 * 改名に影響されない列で行う。
 *
 * ## `token_type_hint` の扱い
 *
 * 受け取るが、探索先は変えない。MVP の `oauth_tokens` には `access` しか
 * 行が無く（仕様書 1.2）、hint を信じて探索を絞っても減る仕事が無い。
 * RFC 7009 §2.1 も hint で見つからなければ他の種別を探せと求めているので、
 * 「常に全部を探す」は適合している。値は監査ログにだけ残す。
 */
export class RevokeAccessTokenUseCase {
  constructor(private readonly deps: RevokeAccessTokenDeps) {}

  async execute(
    command: RevokeAccessTokenCommand,
  ): Promise<UseCaseResult<RevokeAccessTokenOutput>> {
    const now = this.deps.clock.now();
    const tokenHash = await this.deps.hasher.hash(command.token);

    const token = await this.deps.tokens.findByTokenHash(tokenHash);

    if (token === null) {
      await this.record("success", "token_not_found", command);
      return ok({ revoked: false });
    }

    if (token.clientId !== command.client.id) {
      // 他人のトークン。失効させずに成功を返す（上のコメント参照）。
      // 監査ログ側では failure として残す——応答は区別しないが、
      // 「どのクライアントが他人のトークンを提示したか」は調査の起点になる。
      await this.record("failure", "client_mismatch", command, token.userId);
      return ok({ revoked: false });
    }

    // 既に失効済みなら Repository が false を返す（冪等）。
    const revoked = await this.deps.tokens.revokeByTokenHash(tokenHash, now);
    await this.record("success", revoked ? "revoked" : "already_revoked", command, token.userId);
    return ok({ revoked });
  }

  private async record(
    outcome: "success" | "failure",
    reason: string,
    command: RevokeAccessTokenCommand,
    userId?: string,
  ): Promise<void> {
    await settleSideEffects(
      "oauth.token.revoked",
      this.deps.audit.record({
        event: "oauth.token.revoked",
        userId,
        outcome,
        reason,
        // トークンもそのハッシュも載せない（仕様書 9 Privacy）。
        // ハッシュを載せると、ログを読める者が発行応答と突き合わせられる。
        metadata: {
          clientId: command.client.clientId,
          tokenTypeHint: command.tokenTypeHint,
        },
      }),
    );
  }
}
