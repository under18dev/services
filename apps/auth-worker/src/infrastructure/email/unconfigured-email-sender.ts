import type { EmailSender, OtpEmail } from "../../application/ports/email-sender.port";

/**
 * メール送信が設定されていない環境向けのダミー。
 *
 * **起動時ではなく送信時に失敗する**のが肝。コンテナ組み立ての時点で
 * throw すると、リクエストごとに走るミドルウェアから例外が飛び、
 * メールと無関係な `/health` や OIDC Discovery まで 500 になる。
 * 設定ミスで落とすべきなのは OTP 送信だけで、Worker 全体ではない。
 */
export class UnconfiguredEmailSender implements EmailSender {
  constructor(private readonly reason: string) {}

  async sendOtp(_email: OtpEmail): Promise<void> {
    throw new Error(`email sending is not configured: ${this.reason}`);
  }
}
