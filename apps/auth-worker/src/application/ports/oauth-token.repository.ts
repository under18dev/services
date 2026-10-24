import type { AccessToken } from "../../domain/entities/access-token";

export interface IssueAccessTokenInput {
  readonly id: string;
  /** **ハッシュを渡す。** 平文はトークン応答にしか存在しない。 */
  readonly tokenHash: string;
  /** `oauth_grants.id`。同意の取り消しが失効の起点になるので必須。 */
  readonly grantId: string;
  /** `oauth_clients.id`（内部 ID）。 */
  readonly clientId: string;
  readonly userId: string;
  /** スペース区切り。 */
  readonly scope: string;
  /** Audience 制限（仕様書 5.3）。発行先の公開 `client_id` を入れる。 */
  readonly audience: string | null;
  readonly expiresAt: Date;
}

/**
 * 発行済み Access Token の永続化 Port（仕様書 14-1 の決定 5）。
 *
 * ## #17（`/oauth/userinfo` / `/oauth/revoke`）へ渡す形
 *
 * Access Token は不透明トークンなので、**検証はすべてこの Port を通る**。
 * #17 が必要とするのは次の 2 つで、どちらもここにある。
 *
 * - `findByTokenHash()` — `Authorization: Bearer <token>` を `TokenHasher` で
 *   ハッシュ化して引く。失効済み・期限切れも行として返るので、可否は
 *   `AccessToken.isUsableAt(now)` で判定する（`SessionRepository.findByTokenHash`
 *   と同じ契約）。claim の絞り込みは `AccessToken.scopes` を
 *   `filterClaimsByScope()` へ渡せばよい。
 * - `revokeByTokenHash()` — RFC 7009 の失効。見つからない / 既に失効済みでも
 *   `false` を返すだけで、呼び出し側は成功として 200 を返せる（RFC 7009 §2.2 は
 *   無効なトークンにも 200 を要求している）。
 *
 * `refresh` 種別は MVP では 1 行も作らない（仕様書 1.2）。`oauth_tokens.token_type`
 * に列はあるが、この Port は `access` しか書き込まない。
 */
export interface OAuthTokenRepository {
  issue(input: IssueAccessTokenInput): Promise<AccessToken>;

  /**
   * ハッシュでトークンを引く。
   *
   * 期限切れ・失効済みも返す。判定を Domain に寄せるのは `Session` と同じ理由で、
   * Repository 側の WHERE 句に有効条件を埋めると「なぜ 401 なのか」を
   * 監査ログに書き分けられなくなる。
   */
  findByTokenHash(tokenHash: string): Promise<AccessToken | null>;

  /** 単体の失効（RFC 7009）。該当なし・失効済みなら false（冪等）。 */
  revokeByTokenHash(tokenHash: string, at: Date): Promise<boolean>;

  /**
   * 同意に紐づくトークンをまとめて失効させる。失効させた件数を返す。
   *
   * 同意の取り消しと、**認可コードのリプレイ検出**（RFC 9700 §4.1.2）で使う。
   */
  revokeByGrant(grantId: string, at: Date): Promise<number>;
}
