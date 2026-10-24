import { newCodeId, newGrantId } from "@u18/domain";
import { formatScope } from "../../domain/services/scope";
import { expiresAt, TokenLifetime } from "../../domain/services/token-lifetime";
import type { AuditLogger } from "../ports/audit-log.port";
import type { AuthorizationCodeRepository } from "../ports/authorization-code.repository";
import type { Clock } from "../ports/clock.port";
import type { RandomTokenGenerator, TokenHasher } from "../ports/crypto.port";
import type { OAuthGrantRepository } from "../ports/oauth-grant.repository";
import type { ValidatedAuthorizationRequest } from "./authorize-request.use-case";
import { settleSideEffects } from "./side-effects";
import { ok, type UseCaseResult } from "./types";

export type IssueAuthorizationCodeCommand = {
  /** `AuthorizeRequestUseCase` を通った要求だけを渡すこと。 */
  readonly request: ValidatedAuthorizationRequest;
  readonly userId: string;
  readonly sessionId: string;
  readonly authTime: Date;
};

export type IssueAuthorizationCodeOutput = {
  /** **平文のコード。ここでしか存在しない。** 保存されるのはハッシュだけ。 */
  readonly code: string;
  readonly state: string | null;
  readonly redirectUri: string;
};

export type IssueAuthorizationCodeDeps = {
  readonly codes: AuthorizationCodeRepository;
  readonly grants: OAuthGrantRepository;
  readonly tokens: RandomTokenGenerator;
  readonly hasher: TokenHasher;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * 認可コードを発行する（仕様書 5.3、#15）。
 *
 * ## 同意の記録を必ず残す
 *
 * 同意画面を省略したファーストパーティでも `oauth_grants` の行を作る。
 * 理由は 2 つある。`oauth_tokens.grant_id` が NOT NULL なので、記録の無い
 * トークンはそもそも表現できない。そして利用者が「どのアプリに何を許可したか」を
 * 一覧し取り消せること（仕様書 1.1）は、画面を出したかどうかとは独立に必要である。
 *
 * ## コードの平文を残さない
 *
 * `code` は戻り値にだけ現れ、DB には `TokenHasher` を通したハッシュが入る。
 * 監査ログにもコードは書かない。認可コードは 60 秒とはいえ、それ自体が
 * トークンと引き換えられる資格情報である（仕様書 7.1）。
 */
export class IssueAuthorizationCodeUseCase {
  constructor(private readonly deps: IssueAuthorizationCodeDeps) {}

  async execute(
    command: IssueAuthorizationCodeCommand,
  ): Promise<UseCaseResult<IssueAuthorizationCodeOutput>> {
    const { request } = command;
    const now = this.deps.clock.now();
    const scope = formatScope(request.scopes);

    // 同意を先に記録する。コードを作ってから同意の記録に失敗すると、
    // 交換時に grant が見つからず `invalid_grant` になる——利用者から見れば
    // 「同意したのにログインできない」という最も分かりにくい壊れ方になる。
    await this.deps.grants.record({
      id: newGrantId(),
      userId: command.userId,
      clientId: request.client.id,
      grantedScopes: scope,
      at: now,
    });

    const code = this.deps.tokens.generate();

    await this.deps.codes.create({
      id: newCodeId(),
      codeHash: await this.deps.hasher.hash(code),
      clientId: request.client.id,
      userId: command.userId,
      // ログアウトで未交換コードを連鎖失効させるために持たせる（#15）。
      sessionId: command.sessionId,
      redirectUri: request.redirectUri,
      scope,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      nonce: request.nonce,
      authTime: command.authTime,
      // 60 秒（仕様書 5.3）。コードは利用者のブラウザからクライアントの
      // サーバーへ渡って即座に交換される値で、それ以上生かす理由が無い。
      expiresAt: expiresAt(now, TokenLifetime.authorizationCodeMs),
    });

    await settleSideEffects(
      "oauth.code.issue",
      this.deps.audit.record({
        event: "oauth.code.issued",
        userId: command.userId,
        outcome: "success",
        metadata: { clientId: request.client.clientId, scope },
      }),
    );

    return ok({ code, state: request.state, redirectUri: request.redirectUri });
  }
}
