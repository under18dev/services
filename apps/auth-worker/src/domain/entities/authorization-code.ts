import type { CodeChallengeMethod } from "../services/pkce";
import { matchesRegisteredRedirectUri } from "../services/redirect-uri";
import { parseScope } from "../services/scope";

export type AuthorizationCodeProps = {
  readonly id: string;
  /** `oauth_clients.id`（内部 ID）。公開される `client_id` ではない。 */
  readonly clientId: string;
  readonly userId: string;
  /** 発行時のブラウザセッション。ログアウトで未交換コードを連鎖失効させる。 */
  readonly sessionId: string | null;
  readonly redirectUri: string;
  /** スペース区切り。authorize 時に確定した値で、交換時に増やせない。 */
  readonly scope: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: CodeChallengeMethod;
  readonly nonce: string | null;
  /** 認可の元になった認証の時刻。ID Token の `auth_time` になる。 */
  readonly authTime: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
};

/**
 * 認可コード（仕様書 5.3 / 7.3）。
 *
 * **コードの平文はこのエンティティに持たせない。** 保存されるのは
 * `code_hash` だけで（`OAuthClient` が `client_secret` を持たないのと同じ方針）、
 * 平文は発行した瞬間にリダイレクト先へ渡して以降どこにも残さない。
 *
 * 「まだ使えるか」の判定をここに置いていないのは意図的である。使用可否は
 * `AuthorizationCodeRepository.consume()` の**条件付き UPDATE の WHERE 句**で
 * 決まり、それが唯一の判断箇所でなければならない。ここに `isUsableAt()` を
 * 生やすと、「読んで判定してから消費する」という書き方を誘発し、同時交換の
 * 片方だけを成功させるという保証（仕様書 7.3）が崩れる。
 * このエンティティが答えるのは、消費に成功した**後**に確かめる事項
 * ——宛先・クライアント・scope が認可時と同じか——に限る。
 */
export class AuthorizationCode {
  private constructor(private readonly props: AuthorizationCodeProps) {}

  static fromPersistence(props: AuthorizationCodeProps): AuthorizationCode {
    return new AuthorizationCode(props);
  }

  get id(): string {
    return this.props.id;
  }
  get clientId(): string {
    return this.props.clientId;
  }
  get userId(): string {
    return this.props.userId;
  }
  get sessionId(): string | null {
    return this.props.sessionId;
  }
  get redirectUri(): string {
    return this.props.redirectUri;
  }
  get codeChallenge(): string {
    return this.props.codeChallenge;
  }
  get codeChallengeMethod(): CodeChallengeMethod {
    return this.props.codeChallengeMethod;
  }
  get nonce(): string | null {
    return this.props.nonce;
  }
  get authTime(): Date {
    return this.props.authTime;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }
  get consumedAt(): Date | null {
    return this.props.consumedAt;
  }

  /** 認可時に確定した scope。 */
  get scopes(): readonly string[] {
    return parseScope(this.props.scope);
  }

  /** スペース区切りのまま必要な場合（トークン応答・`oauth_tokens.scope`）。 */
  get rawScope(): string {
    return this.props.scope;
  }

  /**
   * 交換時の `redirect_uri` が authorize 時と同じか（RFC 6749 §4.1.3）。
   *
   * 完全一致で比較する。認可時の照合と同じ関数を通すことで、片方だけが
   * 「気を利かせた」比較になる余地を無くす。
   *
   * この検証が要るのは、`redirect_uri` を省略・差し替えできると、攻撃者が
   * 自分の登録済み宛先でコードを受け取り直す余地が生まれるため。
   */
  matchesRedirectUri(requested: string): boolean {
    return matchesRegisteredRedirectUri(requested, [this.props.redirectUri]);
  }

  /**
   * コードを発行したクライアントと、交換時に認証されたクライアントが同じか。
   *
   * 比較するのは内部 ID。`client_id` は公開値なので、照合の軸を内部 ID に
   * 寄せておくと「同じ client_id の別の行」を取り違える余地が無い。
   */
  belongsToClient(internalClientId: string): boolean {
    return this.props.clientId === internalClientId;
  }

  snapshot(): AuthorizationCodeProps {
    return { ...this.props };
  }
}
