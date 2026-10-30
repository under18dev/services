/**
 * PKCE（RFC 7636）の `code_verifier` / `code_challenge` を組み立てる。
 *
 * ## なぜ Web Crypto だけで書くのか
 *
 * u18 Identity 自身が決定 9 で **S256 を必須**にしている（§14.1）。
 * `admin-worker` は u18 の OAuth クライアントなので、自分が IdP に課して
 * いる規則を自分でも守る。独自の暗号プリミティブは作らない（仕様書 5.4）ので
 * 乱数は Web Crypto、ハッシュは SHA-256 をそのまま使う。
 *
 * ## エンコードは base64url（パディング無し）
 *
 * RFC 7636 §4.1 が `code_verifier` の文字集合を `[A-Za-z0-9-._~]` に、
 * §4.2 が `code_challenge` の符号化を base64url（パディング無し）に
 * 決めている。`+ /` を `- _` へ、`=` を落とす変換で満たす。
 */

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** `code_verifier` を作る。43〜128 文字の範囲で、32 バイトの乱数は 43 文字になる。 */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** `code_verifier` から S256 の `code_challenge` を作る。 */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * `state` / `nonce` に使う乱数。
 *
 * **`state` は CSRF 対策、`nonce` はトークンリプレイ対策**で役目が違うが、
 * 作り方は同じ（32 バイトの乱数）なので 1 つの関数にしてある。呼び分けは
 * 呼び出し側の名前で読む。
 */
export function generateOpaqueValue(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
