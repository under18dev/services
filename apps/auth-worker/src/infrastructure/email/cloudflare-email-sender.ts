import { EmailSendError } from "../../application/ports/email-sender.port";
import type { EmailSender, OtpEmail } from "../../application/ports/email-sender.port";

/**
 * Cloudflare Email Sending によるメール送信（仕様書 14-3 の決定）。
 *
 * `send_email` バインディング経由で送るため API キーを Secret に持たない。
 *
 * 注意: 同じ `send_email` という名前でも Email Routing のバインディングは
 * 「検証済み destination address にしか送れない」別物。こちらは Email Service
 * （Email Sending, Workers Paid）で任意の宛先に送れる。
 */
export class CloudflareEmailSender implements EmailSender {
  constructor(
    private readonly binding: SendEmail,
    /** 送信元アドレス。ドメインが Email Service で検証済みである必要がある。 */
    private readonly from: string,
  ) {}

  async sendOtp(email: OtpEmail): Promise<void> {
    try {
      await this.binding.send({
        to: email.to,
        from: this.from,
        subject: subjectFor(email),
        text: textBody(email),
        html: htmlBody(email),
      });
    } catch (cause) {
      // 送信失敗の理由を**利用者へは**返さない。「このアドレスは抑制済み」
      // などを区別させると、アカウント列挙の材料になる（仕様書 9）。
      //
      // ただし呼び出し元には渡す。監査ログに残すのに要る（#141）。
      // 本番で E_RECIPIENT_NOT_ALLOWED が出続けていたのに監査ログが
      // success のままだった、というのが起票の理由である。
      const code = (cause as { code?: string } | null)?.code ?? "unknown";
      console.error("otp email send failed", { code });
      throw new EmailSendError(code, cause);
    }
  }
}

function subjectFor(email: OtpEmail): string {
  switch (email.purpose) {
    case "signup":
      return "u18 アカウント登録の確認コード";
    case "login":
      return "u18 ログインの確認コード";
    case "verify_email":
      return "u18 メールアドレスの確認コード";
    case "recovery":
      return "u18 アカウント復旧の確認コード";
  }
}

function textBody(email: OtpEmail): string {
  return [
    `確認コード: ${email.code}`,
    "",
    `このコードは ${email.expiresInMinutes} 分で無効になります。`,
    "心当たりがない場合、このメールは破棄してください。",
    "",
    "u18 がこのコードを尋ねることはありません。",
  ].join("\n");
}

function htmlBody(email: OtpEmail): string {
  // 外部リソースを参照しない。画像やトラッキングを入れると
  // メールクライアント側でブロックされ、コードが読めなくなることがある。
  return [
    "<!doctype html><html><body>",
    `<p>確認コード: <strong style="font-size:1.5em;letter-spacing:0.2em">${email.code}</strong></p>`,
    `<p>このコードは ${email.expiresInMinutes} 分で無効になります。</p>`,
    "<p>心当たりがない場合、このメールは破棄してください。</p>",
    "<p>u18 がこのコードを尋ねることはありません。</p>",
    "</body></html>",
  ].join("");
}
