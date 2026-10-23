/**
 * メールアドレスの Value Object。
 *
 * 認証の主キーにはしない（仕様書 6.2）が、OTP の宛先・重複検出には正規形が要る。
 * RFC 5321 を完全に実装はせず、「実運用で受け付けるべき形」に絞って検証する。
 */

export class InvalidEmailAddressError extends Error {
  override readonly name = "InvalidEmailAddressError";
  constructor(reason: string) {
    super(`invalid email address: ${reason}`);
  }
}

/** local@domain の 1 つの @ だけを許し、空白・制御文字を拒否する。 */
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@.]+(\.[^\s@.]+)+$/;

const MAX_LENGTH = 254; // RFC 5321 の経路長上限

export class EmailAddress {
  private constructor(readonly value: string) {}

  /**
   * 正規化して生成する。
   *
   * 正規化はドメイン部の小文字化までに留める。local 部の小文字化や
   * Gmail のドット除去などの「プロバイダ固有の同一視」は、別人のアドレスを
   * 同一視してしまう危険があるため行わない。
   */
  static create(raw: string): EmailAddress {
    const trimmed = raw.trim();
    if (trimmed.length === 0) throw new InvalidEmailAddressError("empty");
    if (trimmed.length > MAX_LENGTH) throw new InvalidEmailAddressError("too long");
    if (!EMAIL_PATTERN.test(trimmed)) throw new InvalidEmailAddressError("malformed");

    const at = trimmed.lastIndexOf("@");
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1).toLowerCase();
    return new EmailAddress(`${local}@${domain}`);
  }

  /** 例外を投げずに判定したい呼び出し元向け。 */
  static tryCreate(raw: string): EmailAddress | null {
    try {
      return EmailAddress.create(raw);
    } catch {
      return null;
    }
  }

  get domain(): string {
    return this.value.slice(this.value.lastIndexOf("@") + 1);
  }

  /** ログ・エラーメッセージ用のマスク表現（仕様書 4.4: 機密情報をログに残さない）。 */
  get masked(): string {
    const at = this.value.lastIndexOf("@");
    const local = this.value.slice(0, at);
    const head = local.slice(0, 1);
    return `${head}${"*".repeat(Math.max(local.length - 1, 1))}@${this.domain}`;
  }

  equals(other: EmailAddress): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
