import type { EmailSender, OtpEmail } from "../../application/ports/email-sender.port";

/**
 * 開発用のメール送信。
 *
 * 送信プロバイダは未決定（仕様書 14-3）。選定までは OTP を Workers のログに出して
 * ローカル開発を進められるようにする。**本番では絶対に使わない** ——
 * OTP がログに残る。composition 側で ENVIRONMENT を見て差し替えること。
 */
export class ConsoleEmailSender implements EmailSender {
  async sendOtp(email: OtpEmail): Promise<void> {
    console.warn(
      `[dev] OTP for ${email.to} (${email.purpose}): ${email.code} — expires in ${email.expiresInMinutes}m`,
    );
  }
}
