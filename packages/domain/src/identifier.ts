/**
 * 内部識別子。
 *
 * 推測可能な連番を外部へ出さないため、ID は crypto 乱数由来の base32url とする。
 * ここは「本当に共有する純粋な Value Object」（仕様書 3）なので Cloudflare にも
 * Node にも依存せず、Web Crypto（Workers / Node / ブラウザ共通）だけを使う。
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32（紛らわしい i l o u を除く）

/** 乱数バイト列を base32 文字列へ符号化する。 */
function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    // 1 バイトあたり 1 文字に落とすので厳密な base32 ではないが、
    // ID 用途では「衝突しない十分なエントロピー」が満たせればよい。
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

/**
 * 接頭辞つきのランダム ID を作る（例: `usr_3k9f...`）。
 * 接頭辞はログを読むときに種別を判別するためで、セキュリティ上の意味は持たせない。
 */
export function newId(prefix: string, byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return `${prefix}_${encodeBase32(bytes)}`;
}

export const newUserId = (): string => newId("usr");
export const newSessionId = (): string => newId("ses");
export const newClientId = (): string => newId("cli");
export const newGrantId = (): string => newId("grt");
export const newTokenId = (): string => newId("tok");
export const newCodeId = (): string => newId("cod");
