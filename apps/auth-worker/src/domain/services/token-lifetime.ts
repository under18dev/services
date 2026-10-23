/**
 * トークン・セッションの有効期間（仕様書 5.3）。
 *
 * 期限の数字をコード中に散らさず、ここを単一の出典にする。
 */
export const TokenLifetime = {
  /** 認可コード: 60 秒。DB で単回交換を原子的に保証する。 */
  authorizationCodeMs: 60 * 1000,
  /** ID Token: 5 分。 */
  idTokenMs: 5 * 60 * 1000,
  /** Access Token: 10 分。 */
  accessTokenMs: 10 * 60 * 1000,
  /** ブラウザセッション: 最大 12 時間。サーバー側で失効可能。 */
  sessionMs: 12 * 60 * 60 * 1000,
  /** メール OTP: 5 分。 */
  emailOtpMs: 5 * 60 * 1000,
  /** WebAuthn Challenge: 5 分。 */
  webauthnChallengeMs: 5 * 60 * 1000,
} as const;

/** OTP の試行・再送の上限（仕様書 9 OTP）。 */
export const OtpPolicy = {
  maxAttempts: 5,
  maxResends: 3,
  /** 再送を受け付けるまでの最短間隔。 */
  resendCooldownMs: 60 * 1000,
  codeLength: 6,
} as const;

export const expiresAt = (now: Date, lifetimeMs: number): Date =>
  new Date(now.getTime() + lifetimeMs);
