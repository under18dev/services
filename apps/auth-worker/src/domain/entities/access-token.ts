import { parseScope } from "../services/scope";

export type AccessTokenProps = {
  readonly id: string;
  /** `oauth_grants.id`。同意を取り消すとこの経路でトークンも失効する。 */
  readonly grantId: string;
  /** `oauth_clients.id`（内部 ID）。 */
  readonly clientId: string;
  readonly userId: string;
  /** スペース区切り。発行時の同意 scope を超えない。 */
  readonly scope: string;
  /** Audience 制限（仕様書 5.3）。MVP では発行先の `client_id` を入れる。 */
  readonly audience: string | null;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
};

/**
 * Access Token（仕様書 14-1 の決定 5）。
 *
 * **不透明トークン + DB 失効**という決定の帰結として、このエンティティが
 * 「トークンの実体」になる。RP が持っている文字列はただのランダム値で、
 * 意味はすべてこの行にある。JWT にしなかったのは、失効を即座に効かせるため
 * （JWT だと introspection が別途要り、MVP の利点が薄い）。
 *
 * トークンの平文は持たせない。`Session` / `AuthorizationCode` と同じく
 * 保存されるのはハッシュだけで、平文は発行応答にしか存在しない（仕様書 7.1）。
 *
 * `/oauth/userinfo` と `/oauth/revoke`（#17）はこのエンティティの
 * `isUsableAt()` と `scopes` だけを見れば判断できる。Repository は行の事実を
 * 返し、可否は Domain が決める——`Session` と同じ分担を崩さない。
 */
export class AccessToken {
  private constructor(private readonly props: AccessTokenProps) {}

  static fromPersistence(props: AccessTokenProps): AccessToken {
    return new AccessToken(props);
  }

  get id(): string {
    return this.props.id;
  }
  get grantId(): string {
    return this.props.grantId;
  }
  get clientId(): string {
    return this.props.clientId;
  }
  get userId(): string {
    return this.props.userId;
  }
  get audience(): string | null {
    return this.props.audience;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }
  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }

  get scopes(): readonly string[] {
    return parseScope(this.props.scope);
  }

  get rawScope(): string {
    return this.props.scope;
  }

  isExpiredAt(now: Date): boolean {
    return this.props.expiresAt.getTime() <= now.getTime();
  }

  get isRevoked(): boolean {
    return this.props.revokedAt !== null;
  }

  /**
   * この時刻に使えるトークンか。
   *
   * `Session.isUsableAt` と同じく、失効と期限切れを畳む。`/oauth/userinfo` が
   * 「失効済み」と「期限切れ」を呼び分けても RP にできることは変わらず、
   * トークンの実在を確かめる材料になるだけである。
   */
  isUsableAt(now: Date): boolean {
    return !this.isRevoked && !this.isExpiredAt(now);
  }

  /** 要求された scope をこのトークンが持っているか（#17 の claim 絞り込み用）。 */
  hasScope(scope: string): boolean {
    return this.scopes.includes(scope);
  }

  snapshot(): AccessTokenProps {
    return { ...this.props };
  }
}
