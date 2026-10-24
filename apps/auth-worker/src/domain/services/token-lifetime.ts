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

  /**
   * `resendWindowMs` の間に同じアドレス・用途へ送ってよい**再送**の回数。
   *
   * 最初の 1 通は再送ではないので、窓あたりの送信は `maxResends + 1` 通になる。
   */
  maxResends: 3,

  /**
   * 再送回数を数える窓の長さ。
   *
   * ## なぜ窓で数えるのか
   *
   * 以前は `email_challenges.resend_count` で数える設計だったが、
   * `StartEmailOtpUseCase` は送信のたびに `invalidateActive()` →`create()` で
   * **新しい行を作る**ため、カウンタは常に新しい行の 0 に戻っていた。
   * 列を進める実装（`recordResend()`）はどこからも呼ばれておらず、
   * 上限判定 `resendCount >= maxResends` は一度も真にならなかった（#88）。
   * 行を作り直す実装に合わせ、「窓の中に何行作られたか」で数える。
   *
   * ## なぜ保持期間より長くできないのか
   *
   * 数える材料は `email_challenges` の行そのものなので、**掃除された行は
   * 数えられない**。窓が `RetentionPolicy.email_challenges` を超えると、
   * 掃除を待つだけで上限を回り込める（#43 との相互作用）。この不変条件は
   * `test/otp-resend-limit.test.ts` で固定してある。
   *
   * 1 時間は保持期間と同じ値だが、**同じ判断ではない**。保持期間は
   * 「いつまで行を残すか」、ここは「どれだけ遡って数えるか」で、
   * 片方を変えてもう片方を変えない事故を上記のテストが止める。
   *
   * ## 窓あたり 4 通で足りるか
   *
   * メールが届かない利用者は 1 時間に 4 通までしか試せない。厳しいが、
   * 現状は 60 秒ごとに無制限（1 時間で 60 通）なので、迷惑行為と送信費用の
   * どちらから見ても現状のほうが悪い。経路全体のレート制限は #21 の範囲。
   */
  resendWindowMs: 60 * 60 * 1000,

  /** 再送を受け付けるまでの最短間隔。 */
  resendCooldownMs: 60 * 1000,
  codeLength: 6,
} as const;

export const expiresAt = (now: Date, lifetimeMs: number): Date =>
  new Date(now.getTime() + lifetimeMs);
