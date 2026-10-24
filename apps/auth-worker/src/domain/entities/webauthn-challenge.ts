export type WebAuthnChallengePurpose = "registration" | "authentication";

export type WebAuthnChallengeProps = {
  readonly id: string;
  /** 登録フローでは確定済み、認証フロー（discoverable）では null。 */
  readonly userId: string | null;
  readonly challenge: string;
  readonly purpose: WebAuthnChallengePurpose;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
};

/**
 * WebAuthn の Challenge（仕様書 9 WebAuthn）。
 *
 * 単回消費そのものは原子的な条件付き UPDATE で保証するので、ここには持たない
 * （Domain のルールで守ろうとすると read-modify-write になり、同時実行で破れる）。
 * このエンティティが担うのは「消費できた Challenge を、本当にこの用途・この
 * 利用者へ使ってよいか」の判定だけ。
 */
export class WebAuthnChallenge {
  private constructor(private readonly props: WebAuthnChallengeProps) {}

  static fromPersistence(props: WebAuthnChallengeProps): WebAuthnChallenge {
    return new WebAuthnChallenge(props);
  }

  get id(): string {
    return this.props.id;
  }
  get userId(): string | null {
    return this.props.userId;
  }
  get challenge(): string {
    return this.props.challenge;
  }
  get purpose(): WebAuthnChallengePurpose {
    return this.props.purpose;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }
  get consumedAt(): Date | null {
    return this.props.consumedAt;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }

  isExpiredAt(now: Date): boolean {
    return this.props.expiresAt.getTime() <= now.getTime();
  }

  /**
   * 発行時の用途・利用者と一致するか。
   *
   * 用途を確かめないと、ログイン用の Challenge を登録の完了に流用できてしまう。
   * 利用者の照合は、他人が受け取った登録 Challenge を横取りさせないため。
   */
  isBoundTo(purpose: WebAuthnChallengePurpose, userId: string | null): boolean {
    return this.props.purpose === purpose && this.props.userId === userId;
  }

  snapshot(): WebAuthnChallengeProps {
    return { ...this.props };
  }
}
