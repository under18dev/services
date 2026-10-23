export type AuthMethod = "passkey" | "email_otp";

export type SessionProps = {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly authMethod: AuthMethod;
  readonly lastSeenAt: Date;
  readonly userAgent: string | null;
  readonly ipHash: string | null;
  readonly createdAt: Date;
};

/**
 * ブラウザセッション。
 *
 * トークンそのものはこのエンティティに持たせない。平文トークンは発行直後の
 * 一度しか存在せず、永続化されるのはハッシュだけ（仕様書 7.1）。
 */
export class Session {
  private constructor(private readonly props: SessionProps) {}

  static fromPersistence(props: SessionProps): Session {
    return new Session(props);
  }

  get id(): string {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }
  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }
  get authMethod(): AuthMethod {
    return this.props.authMethod;
  }
  get lastSeenAt(): Date {
    return this.props.lastSeenAt;
  }
  get userAgent(): string | null {
    return this.props.userAgent;
  }
  get ipHash(): string | null {
    return this.props.ipHash;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }

  isExpiredAt(now: Date): boolean {
    return this.props.expiresAt.getTime() <= now.getTime();
  }

  get isRevoked(): boolean {
    return this.props.revokedAt !== null;
  }

  /**
   * この時刻に使えるセッションか。
   *
   * 失効・期限切れを「存在しない」と同じに扱うため、呼び出し側が
   * 理由で分岐しなくて済むようにしている。理由を外へ返すと、
   * 攻撃者に「そのトークンは存在した」と教えることになる。
   */
  isUsableAt(now: Date): boolean {
    return !this.isRevoked && !this.isExpiredAt(now);
  }

  snapshot(): SessionProps {
    return { ...this.props };
  }
}
