/**
 * 暗号処理の Port。
 *
 * 独自の暗号プリミティブは作らない（仕様書 5.4）。実装は Web Crypto に委ねる。
 */
export interface TokenHasher {
  /**
   * トークン・コードを保存用にハッシュ化する。
   * 高エントロピーなランダム値が前提なので、パスワード用の遅いハッシュではなく
   * SHA-256 を使う。
   */
  hash(value: string): Promise<string>;
}

export interface RandomTokenGenerator {
  /** URL セーフなランダム文字列。セッショントークン・認可コードに使う。 */
  generate(byteLength?: number): string;
  /** 数字のみの OTP。 */
  generateNumericCode(digits: number): string;
}

export interface ConstantTimeComparator {
  /** タイミング攻撃を避けるため、長さが一致する前提で定時間比較する。 */
  equals(a: string, b: string): boolean;
}

export interface IpHasher {
  /** 生 IP を保存しないためのハッシュ化（仕様書 9 Privacy）。 */
  hash(ip: string): Promise<string>;
}
