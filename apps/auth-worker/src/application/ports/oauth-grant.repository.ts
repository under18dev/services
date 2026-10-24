import type { OAuthGrant } from "../../domain/entities/oauth-grant";

export interface RecordOAuthGrantInput {
  /** 新規作成時に使う ID。既存行があれば無視される。 */
  readonly id: string;
  readonly userId: string;
  /** `oauth_clients.id`（内部 ID）。 */
  readonly clientId: string;
  /** スペース区切り。既存の同意があれば**和集合**で上書きする。 */
  readonly grantedScopes: string;
  readonly at: Date;
}

/**
 * ユーザーの同意の永続化 Port（仕様書 1.1 / 7.1）。
 */
export interface OAuthGrantRepository {
  /**
   * `(user_id, client_id)` の同意を引く。
   *
   * 取り消し済みでも行は返す。`Session` / `OAuthClient` と同じく、Repository は
   * 事実を返し「使ってよいか」は Domain（`OAuthGrant.covers`）が決める。
   */
  find(userId: string, clientId: string): Promise<OAuthGrant | null>;

  /**
   * 同意を記録する。既にあれば scope を広げ、取り消し済みなら復活させる。
   *
   * `oauth_grants_user_client_unique` があるので「無ければ作る」を
   * 2 文に分けず、`INSERT ... ON CONFLICT DO UPDATE` 1 文で行うこと。
   * 同じ利用者が 2 つのタブで同時に同意すると、分けた実装では両方が
   * 「行が無い」と判断して片方が unique 制約で落ちる。
   */
  record(input: RecordOAuthGrantInput): Promise<OAuthGrant>;

  /**
   * 同意を取り消す。すでに取り消し済みなら false（冪等）。
   *
   * **ここではトークンを失効させない。** トークンの失効は
   * `OAuthTokenRepository.revokeByGrant()` の仕事で、呼び出し順は
   * UseCase が決める。Repository が別のテーブルへ波及すると、
   * 「何がどこまで消えるか」が SQL を読まないと分からなくなる。
   */
  revoke(userId: string, clientId: string, at: Date): Promise<boolean>;
}
