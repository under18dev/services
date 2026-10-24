import { disallowedScopes, parseScope } from "../services/scope";

export type OAuthGrantProps = {
  readonly id: string;
  readonly userId: string;
  /** `oauth_clients.id`（内部 ID）。 */
  readonly clientId: string;
  /** 同意済み scope（スペース区切り）。 */
  readonly grantedScopes: string;
  readonly grantedAt: Date;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
};

/**
 * ユーザーの同意（仕様書 1.1 / 7.1）。
 *
 * 「このアプリにこの scope を許可した」という記録で、ダッシュボードから
 * 取り消せる。`oauth_tokens.grant_id` がここを指しているので、同意の取り消しは
 * 発行済みトークンの失効の起点にもなる。
 *
 * **ファーストパーティで同意画面を省略した場合も行は作る。** 画面を出すかどうかと、
 * 同意の記録を残すかどうかは別の話である。行を作らないと利用者が許可済みの
 * アプリ一覧を見られず、取り消す手段も無くなる。何より `oauth_tokens.grant_id` は
 * NOT NULL なので、記録の無いトークンは表現できない。
 */
export class OAuthGrant {
  private constructor(private readonly props: OAuthGrantProps) {}

  static fromPersistence(props: OAuthGrantProps): OAuthGrant {
    return new OAuthGrant(props);
  }

  get id(): string {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get clientId(): string {
    return this.props.clientId;
  }
  get grantedAt(): Date {
    return this.props.grantedAt;
  }
  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  get scopes(): readonly string[] {
    return parseScope(this.props.grantedScopes);
  }

  get isRevoked(): boolean {
    return this.props.revokedAt !== null;
  }

  /**
   * 要求 scope がこの同意に収まっているか。
   *
   * **部分集合であることを要求する。** 等しいことではない。前回 `openid profile`
   * に同意したユーザーに、今回 `openid` だけを要求するアプリへ同意画面を
   * 出し直す意味は無い。
   *
   * 逆に 1 つでもはみ出していれば同意を取り直す。はみ出した分だけを足して
   * 黙って通すと、アプリは「少しずつ要求を増やす」ことで利用者に気付かれずに
   * scope を広げられる。
   *
   * 取り消し済みの同意では常に false。取り消しは「過去の許可を無かったことに
   * する」操作なので、残った文字列が許可の根拠になってはならない。
   */
  covers(requested: readonly string[]): boolean {
    if (this.isRevoked) return false;
    return disallowedScopes(requested, this.scopes).length === 0;
  }

  snapshot(): OAuthGrantProps {
    return { ...this.props };
  }
}
