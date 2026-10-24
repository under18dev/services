export interface OtpEmail {
  readonly to: string;
  readonly code: string;
  readonly purpose: "login" | "signup" | "verify_email" | "recovery";
  readonly expiresInMinutes: number;
}

/**
 * メール送信の Port。
 *
 * 送信プロバイダの選定は仕様書 §14.1 決定 3（Cloudflare Email Sending）だが、
 * Application からはこの 1 メソッドだけを見るようにして差し替え可能にしておく。
 *
 * **失敗したときは `EmailSendError` を投げること。** 戻り値で成否を返さないのは、
 * 呼び出し側が結果を見落としたまま「送れたつもり」で進めないようにするため。
 */
export interface EmailSender {
  sendOtp(email: OtpEmail): Promise<void>;
}

/**
 * 送信の失敗。
 *
 * **Infrastructure ではなくここに置いてある。** 送信が失敗したという事実と
 * その分類は、呼び出し側（UseCase）が監査ログへ書くのに必要で、
 * Application が Infrastructure を import することはできないため
 * （`packages/config/eslint.layers.js`）。
 *
 * プロバイダ固有のエラーコードは `code` に入れる。**利用者へは返さない。**
 * 「このアドレスは抑制済み」などを区別させるとアカウント列挙の材料になる
 * （仕様書 §9）。監査ログと運用ログの中だけで使う値である。
 */
export class EmailSendError extends Error {
  override readonly name = "EmailSendError";

  constructor(
    /** プロバイダのエラーコード（例: `E_RECIPIENT_NOT_ALLOWED`）。不明なら `"unknown"`。 */
    readonly code: string,
    cause: unknown,
  ) {
    // message にコードを載せない。そのまま応答へ漏れたときに
    // 内部状態を外へ出してしまう。
    super("failed to send email", { cause });
  }
}
