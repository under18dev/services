/**
 * PKCE の形式規則（RFC 7636 / 仕様書 5.1・9）。
 *
 * ここにあるのは**形の判定だけ**で、`code_verifier` から challenge を計算する
 * 処理は入れない。計算には SHA-256 が要り、それは Port
 * （`PkceChallengeVerifier`）の向こう側に置く。Domain に Web Crypto の呼び出しを
 * 入れると、「暗号をどこで行うか」が 2 箇所に散る。
 *
 * ## `plain` を型にも持たせない理由
 *
 * RFC 7636 は `plain`（challenge == verifier）を定義しているが、u18 は
 * S256 のみを受け付ける。`plain` は認可要求を観測できる相手——ブラウザの
 * 履歴、Referer、中間のプロキシ——がそのまま `code_verifier` を手に入れる
 * ことを意味し、PKCE が防ごうとしている認可コード横取りに対して無力になる。
 * Discovery も `code_challenge_methods_supported: ["S256"]` しか広告しない。
 *
 * 受け付けない値を型に持たせると、「どこかで弾いているはず」という前提に
 * 寄りかかった分岐が後から生える。`CodeChallengeMethod` を `"S256"` だけに
 * してあるので、`plain` を通す経路は型の時点で書けない。
 */

/** u18 が受け付ける `code_challenge_method`。S256 のみ。 */
export type CodeChallengeMethod = "S256";

/**
 * `code_verifier` の長さ（RFC 7636 §4.1）。
 *
 * 下限 43 文字は 256bit のエントロピーを base64url で表した長さで、総当たりを
 * 現実的でなくするための最低線。上限 128 文字は URL とヘッダの肥大を抑えるため。
 */
const VERIFIER_MIN_LENGTH = 43;
const VERIFIER_MAX_LENGTH = 128;

/** RFC 7636 §4.1 の `unreserved` 文字集合。 */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]+$/;

/**
 * S256 の `code_challenge` は SHA-256（32 バイト）の base64url なので、
 * パディング無しで必ず 43 文字になる。
 */
const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43}$/;

/**
 * `code_challenge` として受け付けてよい形か。
 *
 * 長さ・文字種を認可の入口で確かめる。ここを通さないと、`code_challenge` に
 * 任意の長さの文字列を入れられ、交換時の定時間比較が「長さが違う」で
 * 即 false を返す経路——つまり比較時間から長さが漏れる経路——が増える。
 * 入口で形を固定しておけば、比較対象は常に 43 文字になる。
 */
export function isValidCodeChallenge(challenge: string): boolean {
  return S256_CHALLENGE_PATTERN.test(challenge);
}

/**
 * `code_challenge_method` が S256 か。
 *
 * **省略を既定値として補完しない。** RFC 7636 は未指定を `plain` とみなすと
 * 定めており、黙って S256 として扱うと RFC と食い違う。かといって `plain` に
 * 落とすのは上のコメントのとおり受け入れられないので、明示を必須にする。
 */
export function isSupportedCodeChallengeMethod(method: string | null): method is "S256" {
  return method === "S256";
}

/** `code_verifier` が RFC 7636 §4.1 の形か。 */
export function isValidCodeVerifier(verifier: string): boolean {
  if (verifier.length < VERIFIER_MIN_LENGTH || verifier.length > VERIFIER_MAX_LENGTH) {
    return false;
  }
  return VERIFIER_PATTERN.test(verifier);
}
