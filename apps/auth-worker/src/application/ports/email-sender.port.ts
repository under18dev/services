export interface OtpEmail {
  readonly to: string;
  readonly code: string;
  readonly purpose: "login" | "signup" | "verify_email" | "recovery";
  readonly expiresInMinutes: number;
}

/**
 * メール送信の Port。
 *
 * 送信プロバイダは未決定（仕様書 14-3）なので、Application からは
 * この 1 メソッドだけを見るようにして差し替え可能にしておく。
 */
export interface EmailSender {
  sendOtp(email: OtpEmail): Promise<void>;
}
