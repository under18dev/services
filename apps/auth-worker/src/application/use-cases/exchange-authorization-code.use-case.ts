import { newTokenId } from "@u18/domain";
import type { OAuthClient } from "../../domain/entities/oauth-client";
import { isValidCodeVerifier } from "../../domain/services/pkce";
import { filterClaimsByScope } from "../../domain/services/scope";
import { expiresAt, TokenLifetime } from "../../domain/services/token-lifetime";
import type { AuditLogger } from "../ports/audit-log.port";
import type { AuthorizationCodeRepository } from "../ports/authorization-code.repository";
import type { Clock } from "../ports/clock.port";
import type { PkceVerifier, RandomTokenGenerator, TokenHasher } from "../ports/crypto.port";
import type { IdTokenIssuer } from "../ports/id-token.port";
import type { OAuthGrantRepository } from "../ports/oauth-grant.repository";
import type { OAuthTokenRepository } from "../ports/oauth-token.repository";
import type { UserRepository } from "../ports/user.repository";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type ExchangeAuthorizationCodeCommand = {
  /** 認証済みのクライアント。`AuthenticateOAuthClientUseCase` の結果を渡すこと。 */
  readonly client: OAuthClient;
  readonly code: string;
  readonly redirectUri: string | null;
  readonly codeVerifier: string | null;
  /** ID Token の `iss`。`env.ISSUER` が正本（仕様書 5.2）。 */
  readonly issuer: string;
};

export type ExchangeAuthorizationCodeOutput = {
  /** **平文の Access Token。ここでしか存在しない。** */
  readonly accessToken: string;
  readonly idToken: string;
  readonly expiresInSeconds: number;
  readonly scope: string;
};

export type ExchangeAuthorizationCodeDeps = {
  readonly codes: AuthorizationCodeRepository;
  readonly grants: OAuthGrantRepository;
  readonly tokens: OAuthTokenRepository;
  readonly users: UserRepository;
  readonly idTokens: IdTokenIssuer;
  readonly hasher: TokenHasher;
  readonly random: RandomTokenGenerator;
  readonly pkce: PkceVerifier;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * 認可コードを Token へ交換する（仕様書 5.3 / 7.3、#16）。
 *
 * ## 手順の順序に意味がある
 *
 * **消費を最初に行う。** 検証（PKCE・`redirect_uri`・クライアント一致）は
 * すべて消費の**後**である。直感には反するが、先に検証すると「読む」と
 * 「使用済みにする」が別のクエリに分かれ、同時に届いた 2 本の交換要求が
 * 両方とも検証を通過しうる（仕様書 7.3）。
 *
 * この順序の帰結として、検証に落ちたコードも消費済みになる。これは
 * 望ましい挙動で、「正しい `code_verifier` を当てるまで何度でも試せる
 * コード」を作らない。
 *
 * ## 失敗理由を細かく返さない
 *
 * `invalid_grant` に畳む。PKCE の不一致・`redirect_uri` の不一致・期限切れ・
 * クライアント違いを呼び分けると、攻撃者は手元のコードについて「何が合って
 * いて何が違うか」を 1 回の要求ごとに 1 ビットずつ確かめられる。
 * 区別は監査ログにだけ残す。
 */
export class ExchangeAuthorizationCodeUseCase {
  constructor(private readonly deps: ExchangeAuthorizationCodeDeps) {}

  async execute(
    command: ExchangeAuthorizationCodeCommand,
  ): Promise<UseCaseResult<ExchangeAuthorizationCodeOutput>> {
    const now = this.deps.clock.now();
    const codeHash = await this.deps.hasher.hash(command.code);

    // ---- 1. 原子的な単回消費 ----
    const consumed = await this.deps.codes.consume(codeHash, now);

    if (consumed.outcome === "replayed") {
      await this.handleReplay(consumed.code.userId, consumed.code.clientId, now);
      return invalidGrant();
    }
    if (consumed.outcome === "unusable") {
      await this.recordFailure("code_unusable", command.client.clientId);
      return invalidGrant();
    }

    const code = consumed.code;

    // ---- 2. コードと提示されたクライアント・宛先の一致 ----
    if (!code.belongsToClient(command.client.id)) {
      // 別のクライアントの認証情報でコードを交換できると、攻撃者は自分の
      // クライアントを登録するだけで他人のコードを現金化できる。
      await this.recordFailure("client_mismatch", command.client.clientId, code.userId);
      return invalidGrant();
    }
    if (command.redirectUri === null || !code.matchesRedirectUri(command.redirectUri)) {
      await this.recordFailure("redirect_uri_mismatch", command.client.clientId, code.userId);
      return invalidGrant();
    }

    // ---- 3. PKCE ----
    if (command.codeVerifier === null || !isValidCodeVerifier(command.codeVerifier)) {
      await this.recordFailure("code_verifier_malformed", command.client.clientId, code.userId);
      return invalidGrant();
    }
    const pkceOk = await this.deps.pkce.verifyS256(command.codeVerifier, code.codeChallenge);
    if (!pkceOk) {
      await this.recordFailure("code_verifier_mismatch", command.client.clientId, code.userId);
      return invalidGrant();
    }

    // ---- 4. 同意とユーザーが今も有効か ----
    //
    // authorize から交換までの間（最大 60 秒）に、利用者が同意を取り消したり
    // アカウントが停止されたりしうる。コードを発行した時点の判断を
    // そのまま信じない。
    const grant = await this.deps.grants.find(code.userId, code.clientId);
    if (grant === null || !grant.covers(code.scopes)) {
      await this.recordFailure("grant_unavailable", command.client.clientId, code.userId);
      return invalidGrant();
    }

    const user = await this.deps.users.findById(code.userId);
    if (user === null || !user.isActive) {
      await this.recordFailure("user_not_active", command.client.clientId, code.userId);
      return invalidGrant();
    }

    // ---- 5. ID Token ----
    const idTokenExpiresAt = expiresAt(now, TokenLifetime.idTokenMs);
    let idToken: string;
    try {
      idToken = await this.deps.idTokens.issue({
        issuer: command.issuer,
        subject: user.id,
        audience: command.client.clientId,
        issuedAt: now,
        expiresAt: idTokenExpiresAt,
        authTime: code.authTime,
        nonce: code.nonce,
        // scope に応じて claim を絞る。`openid` だけなら `sub` のみ。
        additionalClaims: filterClaimsByScope(user.toClaims(), code.scopes),
      });
    } catch (error) {
      // 署名鍵の設定不備（`SigningKeyProvider` は throw する）。利用者にも
      // クライアントにも直せない問題なので、入力の誤りを表す `invalid_*` と
      // 混ぜずに分ける。コードは既に消費済みで、再試行しても同じ結果になる。
      console.error("id token signing failed", error);
      await this.recordFailure("id_token_signing_failed", command.client.clientId, code.userId);
      return err("server_error", "token issuance is temporarily unavailable");
    }

    // ---- 6. Access Token（不透明トークン + DB 失効。決定 14-1 の 5）----
    const accessToken = this.deps.random.generate();
    const accessTokenExpiresAt = expiresAt(now, TokenLifetime.accessTokenMs);

    await this.deps.tokens.issue({
      id: newTokenId(),
      tokenHash: await this.deps.hasher.hash(accessToken),
      grantId: grant.id,
      clientId: code.clientId,
      userId: user.id,
      scope: code.rawScope,
      // Audience は発行先のクライアント（仕様書 5.3）。#17 の userinfo が
      // 「誰に出したトークンか」を行だけで判断できるようにしておく。
      audience: command.client.clientId,
      expiresAt: accessTokenExpiresAt,
    });

    await settleSideEffects(
      "oauth.token.issue",
      this.deps.audit.record({
        event: "oauth.token.issued",
        userId: user.id,
        outcome: "success",
        metadata: { clientId: command.client.clientId, scope: code.rawScope },
      }),
    );

    return ok({
      accessToken,
      idToken,
      expiresInSeconds: Math.floor(TokenLifetime.accessTokenMs / 1000),
      scope: code.rawScope,
    });
  }

  /**
   * 認可コードの再利用を検出したときの後始末（RFC 9700 §4.1.2）。
   *
   * ## 実装すると判断した理由
   *
   * 消費済みのコードがもう一度提示されたということは、そのコードが**2 箇所に
   * 存在した**ことを意味する。正規のクライアントは 1 回しか交換しないので、
   * ブラウザ履歴・Referer・プロキシログ・リダイレクト先の取り違えなど、
   * どこかで漏れたと考えるのが妥当である。1 回目に発行されたトークンが
   * 攻撃者の手元にある可能性があり、そのまま 10 分間生かしておく理由が無い。
   * `invalid_grant` を返すだけでは、既に出てしまったトークンに何も作用しない。
   *
   * ## 失効の単位を grant にした理由
   *
   * RFC 9700 が求めるのは「そのコードから発行されたトークン」の失効だが、
   * `oauth_tokens` には発行元のコードを指す列が無い（スキーマは #16 の
   * 対象外で変更しない）。代わりに `grant_id`——つまり同じ
   * `(user_id, client_id)` 対——で失効させる。要求より**広い**範囲になるが、
   * 安全側である。巻き込まれるのは同じ利用者が同じクライアントへ出した
   * 他のトークンだけで、クライアントは認可をやり直せば回復できる。
   * 狭める方向（= 失効し損ねる）の誤りより、こちらのほうが損失が小さい。
   */
  private async handleReplay(userId: string, clientId: string, now: Date): Promise<void> {
    const grant = await this.deps.grants.find(userId, clientId);
    const revokedCount = grant === null ? 0 : await this.deps.tokens.revokeByGrant(grant.id, now);

    await settleSideEffects(
      "oauth.code.replayed",
      this.deps.audit.record({
        event: "oauth.code.replayed",
        userId,
        outcome: "failure",
        reason: "authorization_code_reuse",
        metadata: { revokedTokenCount: revokedCount },
      }),
    );
  }

  private async recordFailure(reason: string, clientId: string, userId?: string): Promise<void> {
    await settleSideEffects(
      "oauth.token.exchange",
      this.deps.audit.record({
        event: "oauth.token.exchange",
        userId,
        outcome: "failure",
        reason,
        metadata: { clientId },
      }),
    );
  }
}

/** 交換の失敗はすべて同じ応答に畳む（RFC 6749 §5.2）。 */
const invalidGrant = (): UseCaseResult<never> =>
  err("invalid_grant", "the authorization code is invalid");
