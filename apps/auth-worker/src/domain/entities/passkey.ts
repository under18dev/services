export type PasskeyDeviceType = "singleDevice" | "multiDevice";

export type PasskeyProps = {
  readonly id: string;
  readonly userId: string;
  /** 認証器が発行した Credential ID（base64url）。RP 全体で一意。 */
  readonly credentialId: string;
  /** COSE 形式の公開鍵（base64url）。秘密鍵は認証器から出てこない。 */
  readonly publicKey: string;
  readonly counter: number;
  readonly aaguid: string | null;
  readonly deviceType: PasskeyDeviceType | null;
  readonly backedUp: boolean;
  readonly transports: readonly string[] | null;
  readonly label: string | null;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
};

/**
 * 登録済みの WebAuthn Credential（仕様書 6.1）。
 *
 * 公開鍵とサインカウンターだけを持つ。検証そのものは Port の実装に委ねるが、
 * 「このカウンターを受け入れてよいか」は方針の問題なのでここに置く。
 */
export class Passkey {
  private constructor(private readonly props: PasskeyProps) {}

  static fromPersistence(props: PasskeyProps): Passkey {
    return new Passkey(props);
  }

  get id(): string {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get credentialId(): string {
    return this.props.credentialId;
  }
  get publicKey(): string {
    return this.props.publicKey;
  }
  get counter(): number {
    return this.props.counter;
  }
  get aaguid(): string | null {
    return this.props.aaguid;
  }
  get deviceType(): PasskeyDeviceType | null {
    return this.props.deviceType;
  }
  get backedUp(): boolean {
    return this.props.backedUp;
  }
  get transports(): readonly string[] | null {
    return this.props.transports;
  }
  get label(): string | null {
    return this.props.label;
  }
  get lastUsedAt(): Date | null {
    return this.props.lastUsedAt;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }

  /**
   * 認証器が申告したサインカウンターを受け入れてよいか（仕様書 9 WebAuthn）。
   *
   * カウンターは認証のたびに単調増加するはずで、増えない値は Credential が
   * 複製されたことを示唆する。保存値と申告値がどちらも 0 のときだけ例外的に
   * 許す。カウンターを実装しない認証器（多くのプラットフォーム認証器）が
   * 常に 0 を返すためで、ここを塞ぐとパスキーの大半がログインできなくなる。
   */
  acceptsCounter(next: number): boolean {
    if (this.props.counter === 0 && next === 0) return true;
    return next > this.props.counter;
  }

  snapshot(): PasskeyProps {
    return { ...this.props };
  }
}
