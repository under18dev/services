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

/**
 * PKCE の `code_verifier` 検証（RFC 7636 §4.6 / 仕様書 9）。
 *
 * `TokenHasher` で代用しない。あちらは保存用の **16 進**ハッシュを返すが、
 * `code_challenge` は **base64url** と定義されており、符号化が違う。
 * 共用すると「どちらの表現か」を呼び出し側が毎回気にすることになる。
 *
 * 比較まで実装側で完結させるのは `OAuthClientRepository.verifySecret` と同じ理由で、
 * 計算したハッシュを外へ返して呼び出し側に `===` させると、早期脱出する比較が
 * 紛れ込む。`code_challenge` は認可要求とともに観測されうる値なので、
 * 比較時間から正解の `code_verifier` を絞り込ませない。
 */
export interface PkceVerifier {
  /**
   * `code_verifier` を SHA-256 → base64url して `code_challenge` と定時間比較する。
   *
   * S256 以外の method は引数に取らない。`plain` を受け付けないという決定
   * （仕様書 5.1）を、呼び出し側の分岐ではなくこの型で表現している。
   */
  verifyS256(codeVerifier: string, codeChallenge: string): Promise<boolean>;
}
