import { UserNotActiveError } from "../errors/domain-error";

export type UserStatus = "active" | "suspended" | "deleted";

export type UserProps = {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly status: UserStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * ユーザー。
 *
 * `id` は不変で、OIDC の `sub` になる。username / email は変更されうるため
 * 同一性の判定には使わない（仕様書 6.2）。
 */
export class User {
  private constructor(private readonly props: UserProps) {}

  static fromPersistence(props: UserProps): User {
    return new User(props);
  }

  get id(): string {
    return this.props.id;
  }
  get username(): string {
    return this.props.username;
  }
  get displayName(): string {
    return this.props.displayName;
  }
  get email(): string {
    return this.props.email;
  }
  get emailVerified(): boolean {
    return this.props.emailVerified;
  }
  get status(): UserStatus {
    return this.props.status;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get isActive(): boolean {
    return this.props.status === "active";
  }

  /** ログイン・トークン発行の前に必ず通す。停止・削除済みの利用を一箇所で止める。 */
  assertCanAuthenticate(): void {
    if (!this.isActive) throw new UserNotActiveError(this.props.status);
  }

  /** OIDC の `profile` / `email` scope に対応する claim。scope 判定は Application 側で行う。 */
  toClaims(): Record<string, unknown> {
    return {
      sub: this.props.id,
      preferred_username: this.props.username,
      name: this.props.displayName,
      email: this.props.email,
      email_verified: this.props.emailVerified,
      updated_at: Math.floor(this.props.updatedAt.getTime() / 1000),
    };
  }

  snapshot(): UserProps {
    return { ...this.props };
  }
}
