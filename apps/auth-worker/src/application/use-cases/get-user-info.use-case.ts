import { filterClaimsByScope } from "../../domain/services/scope";
import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { TokenHasher } from "../ports/crypto.port";
import type { OAuthGrantRepository } from "../ports/oauth-grant.repository";
import type { OAuthTokenRepository } from "../ports/oauth-token.repository";
import type { UserRepository } from "../ports/user.repository";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type GetUserInfoCommand = {
  /** `Authorization: Bearer <token>` から取り出した**平文**の Access Token。 */
  readonly accessToken: string;
};

export type GetUserInfoOutput = {
  /** scope で絞った後の claim。`sub` は常に入る。 */
  readonly claims: Record<string, unknown>;
};

export type GetUserInfoDeps = {
  readonly tokens: OAuthTokenRepository;
  readonly grants: OAuthGrantRepository;
  readonly users: UserRepository;
  readonly hasher: TokenHasher;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * `/oauth/userinfo`（仕様書 5.2、#17）。
 *
 * ## 不透明トークンなので、検証はすべて DB を通る
 *
 * Access Token は JWT ではない（仕様書 14-1 の決定 5）。RP が持っているのは
 * ただのランダム文字列で、意味は `oauth_tokens` の行にしかない。したがって
 * 「トークンを検証する」とは、ハッシュで行を引き、その行と周辺の状態が今も
 * 整合しているかを確かめることに等しい。その代わり失効が即座に効く。
 *
 * ## 4 つの関門を順に通す
 *
 * 1. トークンの行が存在する
 * 2. 失効も期限切れもしていない（`AccessToken.isUsableAt`）
 * 3. 根拠となった**同意が今も生きている**
 * 4. 利用者が今も有効（active かつ未削除）
 *
 * 3 が要るのは、同意の取り消しとトークンの失効が別のテーブルへの書き込みで、
 * 原理的にずれうるからである。`RevokeGrantUseCase` は両方を書くが、
 * 片方だけ成功した状態や、将来別経路から `oauth_grants` だけを落とした場合に、
 * ここが最後の砦になる。「同意を取り消したのに情報が返り続ける」は、
 * 利用者から見て取り消しが効いていないのと同じである。
 *
 * ## 失敗理由を呼び分けない
 *
 * 4 つのどこで落ちても `invalid_token` ひとつに畳む（RFC 6750 §3.1）。
 * 「期限切れ」と「そんなトークンは無い」を区別して返すと、手元の文字列が
 * **かつて実在したか**を確かめる道具になる。区別は監査ログにだけ残す。
 *
 * ## 停止・凍結された利用者の扱い
 *
 * 拒否する。決定 7 により凍結アカウントの行は残り、`oauth_tokens` の行も
 * 期限が切れるまでそのまま残る——つまり「行があるから有効」ではない。
 * `GetSessionUseCase` がブラウザセッションに対して同じ判断をしており、
 * セッションは切れるのに Access Token だけが 10 分間 claim を返し続ける、
 * という食い違いを作らない。トークンそのものを一括失効させないのは、
 * 凍結の解除が「状態を戻すだけ」で済むようにしておくためで、
 * 解除されれば同じトークンが残り時間だけまた通る。
 */
export class GetUserInfoUseCase {
  constructor(private readonly deps: GetUserInfoDeps) {}

  async execute(command: GetUserInfoCommand): Promise<UseCaseResult<GetUserInfoOutput>> {
    const now = this.deps.clock.now();
    const tokenHash = await this.deps.hasher.hash(command.accessToken);

    const token = await this.deps.tokens.findByTokenHash(tokenHash);
    if (token === null) {
      // userId が分からないので監査ログに載せられない。載せられる手掛かりが
      // 何も無いこと自体が「そんなトークンは発行していない」の意味になる。
      await this.recordFailure("token_not_found");
      return invalidToken();
    }

    if (!token.isUsableAt(now)) {
      await this.recordFailure(token.isRevoked ? "token_revoked" : "token_expired", token.userId, {
        clientId: token.audience,
      });
      return invalidToken();
    }

    const grant = await this.deps.grants.find(token.userId, token.clientId);
    // `covers` は取り消し済みの同意に対して常に false を返すので、
    // 「取り消された」と「scope が狭められた」を 1 つの条件で拾える。
    if (grant === null || !grant.covers(token.scopes)) {
      await this.recordFailure("grant_unavailable", token.userId, { clientId: token.audience });
      return invalidToken();
    }

    const user = await this.deps.users.findById(token.userId);
    if (user === null || !user.isActive) {
      await this.recordFailure("user_not_active", token.userId, { clientId: token.audience });
      return invalidToken();
    }

    // `sub` は `users.id`。ID Token の `sub` と同じ値になるのは、どちらも
    // `User.toClaims()` を通しているからで、ここで組み立て直していない。
    // 別々に作ると、片方だけ username へ変えるような変更が通ってしまう。
    const claims = filterClaimsByScope(user.toClaims(), token.scopes);

    return ok({ claims });
  }

  private async recordFailure(
    reason: string,
    userId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await settleSideEffects(
      "oauth.userinfo",
      this.deps.audit.record({
        event: "oauth.userinfo",
        userId,
        outcome: "failure",
        reason,
        metadata,
      }),
    );
  }
}

/** RFC 6750 §3.1 の `invalid_token`。Presentation が 401 と challenge に写す。 */
const invalidToken = (): UseCaseResult<never> =>
  err("invalid_token", "the access token is invalid or expired");
