export type OtpPurpose = "login" | "signup" | "verify_email" | "recovery";

export type EmailChallenge = {
  readonly id: string;
  readonly userId: string | null;
  readonly email: string;
  readonly purpose: OtpPurpose;
  readonly expiresAt: Date;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly consumedAt: Date | null;
  readonly resendCount: number;
  readonly lastSentAt: Date | null;
  readonly createdAt: Date;
};

export type CreateEmailChallengeInput = {
  readonly id: string;
  readonly userId: string | null;
  readonly email: string;
  /** OTP そのものではなくハッシュ。 */
  readonly codeHash: string;
  readonly purpose: OtpPurpose;
  readonly expiresAt: Date;
  readonly maxAttempts: number;
  readonly sentAt: Date;
};

export type ConsumeResult =
  /** コードが一致し、この呼び出しが消費に成功した。 */
  | { readonly outcome: "consumed"; readonly challenge: EmailChallenge }
  /** コードが違う。試行回数は加算済み。 */
  | { readonly outcome: "mismatch"; readonly attemptsRemaining: number }
  /** 試行上限に達した。これ以上は一致しても受け付けない。 */
  | { readonly outcome: "exhausted" }
  /** 期限切れ・使用済み・そもそも存在しない。区別せず畳む。 */
  | { readonly outcome: "unusable" };

export interface EmailChallengeRepository {
  create(input: CreateEmailChallengeInput): Promise<EmailChallenge>;

  /**
   * そのメールアドレス・用途で、まだ使える最新のチャレンジを返す。
   * 再送のクールダウン判定に使う。
   */
  findActive(email: string, purpose: OtpPurpose, now: Date): Promise<EmailChallenge | null>;

  /**
   * コードを検証して単回消費する。
   *
   * **照合・試行回数の加算・消費を 1 つの原子的な操作として行うこと**
   * （仕様書 7.3）。「読んでから書く」を分けて実装すると、同じコードを
   * 並行して送りつけることで試行上限を超えられるか、同じコードで 2 回
   * ログインできてしまう。
   */
  consume(email: string, purpose: OtpPurpose, codeHash: string, now: Date): Promise<ConsumeResult>;

  /** 再送時に送信回数と最終送信時刻を進める。 */
  recordResend(id: string, at: Date): Promise<void>;

  /**
   * 同じメール・用途の未使用チャレンジを無効化する。
   * 新しいコードを出す前に呼び、古いコードが生き残らないようにする。
   */
  invalidateActive(email: string, purpose: OtpPurpose, at: Date): Promise<number>;
}
