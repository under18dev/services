export interface AuditEvent {
  readonly event: string;
  readonly userId?: string | undefined;
  readonly actor?: string | undefined;
  readonly outcome: "success" | "failure";
  readonly reason?: string | undefined;
  /** 秘密（トークン・OTP・生 IP・メールアドレス）を入れないこと。 */
  readonly metadata?: Record<string, unknown> | undefined;
  readonly ipHash?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * 監査ログの Port。
 *
 * 記録の失敗で本来の処理を落とさないこと。ログが書けないからといって
 * ログインを拒否すると、可用性の問題がそのまま認証停止になる。
 */
export interface AuditLogger {
  record(event: AuditEvent): Promise<void>;
}
