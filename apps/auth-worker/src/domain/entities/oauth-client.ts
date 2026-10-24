import { matchesRegisteredRedirectUri } from "../services/redirect-uri";
import { parseScope } from "../services/scope";

export type OAuthClientType = "confidential" | "public";

export type OAuthClientProps = {
  /** 内部 ID（`cli_...`）。外部へは出さない。 */
  readonly id: string;
  /** OIDC の `client_id`。公開される値。 */
  readonly clientId: string;
  readonly name: string;
  readonly clientType: OAuthClientType;
  /** スペース区切りの許可 scope をそのまま持つ。 */
  readonly allowedScopes: string;
  readonly isFirstParty: boolean;
  readonly logoUrl: string | null;
  readonly disabledAt: Date | null;
  /** 登録済み Redirect URI。クライアントと同時に読み込む。 */
  readonly redirectUris: readonly string[];
  readonly createdAt: Date;
};

/**
 * OAuth クライアント。
 *
 * `client_secret` はこのエンティティに持たせない。セッションのトークンと同じく
 * 保存されるのはハッシュだけで（仕様書 7.1）、照合は Repository 側の
 * 定時間比較で完結させる。ハッシュを Domain まで持ち上げると、
 * 比較のたびに「どこで漏れるか」を考える対象が増える。
 */
export class OAuthClient {
  private constructor(private readonly props: OAuthClientProps) {}

  static fromPersistence(props: OAuthClientProps): OAuthClient {
    return new OAuthClient(props);
  }

  get id(): string {
    return this.props.id;
  }
  get clientId(): string {
    return this.props.clientId;
  }
  get name(): string {
    return this.props.name;
  }
  get clientType(): OAuthClientType {
    return this.props.clientType;
  }
  get isFirstParty(): boolean {
    return this.props.isFirstParty;
  }
  get logoUrl(): string | null {
    return this.props.logoUrl;
  }
  get disabledAt(): Date | null {
    return this.props.disabledAt;
  }
  get redirectUris(): readonly string[] {
    return this.props.redirectUris;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }

  /** confidential は `client_secret` を持ち、public は PKCE だけで認証する（仕様書 5.1）。 */
  get isConfidential(): boolean {
    return this.props.clientType === "confidential";
  }

  /**
   * 失効済みか。
   *
   * `disabled_at` は「いつ止めたか」の記録であって、未来日付のスケジュールではない。
   * 立っていれば時刻に関係なく即座に拒否する（#13 受け入れ条件）。
   */
  get isDisabled(): boolean {
    return this.props.disabledAt !== null;
  }

  /** このクライアントに許可された scope。 */
  get allowedScopes(): readonly string[] {
    return parseScope(this.props.allowedScopes);
  }

  /** 要求された `redirect_uri` が登録済みか。完全一致のみ（仕様書 9）。 */
  matchesRedirectUri(requested: string): boolean {
    return matchesRegisteredRedirectUri(requested, this.props.redirectUris);
  }

  snapshot(): OAuthClientProps {
    return { ...this.props };
  }
}
