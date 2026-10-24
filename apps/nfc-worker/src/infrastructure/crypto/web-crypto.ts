import type { ClaimCodeService } from "../../application/ports";

const encoder = new TextEncoder();

/**
 * 紐づけコードの文字集合。
 *
 * Crockford base32 から `i l o u` を除いてある（`@u18/domain` の
 * `newId` と同じ理由）。このコードは**紙に印刷して人が手で入力する**ので、
 * 1 と l、0 と O の取り違えが起きる文字を残すと、正しいコードを持つ人が
 * 弾かれる。弾かれた人は「もう一度試す」しかなく、総当たり対策との
 * 相性も悪い。
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * コード長。32 文字集合 × 16 文字 = 80bit。
 *
 * 紙片に印刷して手入力させる上限がこのあたり。80bit は、レート制限が
 * 入っていない現状でも総当たりが現実的でない水準にしてある
 * （カード ID 側の 100bit と合わせて、両方を当てる必要がある）。
 */
const CLAIM_CODE_LENGTH = 16;

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 紐づけコードの生成とハッシュ化。
 *
 * 独自の暗号プリミティブは作らない（仕様書 5.4）。乱数は Web Crypto、
 * ハッシュは SHA-256。対象が 80bit のランダム値なので、パスワード用の
 * 遅いハッシュは不要 —— むしろ検証のたびに CPU 時間を使う分だけ
 * Workers では不利になる（auth-worker の `Sha256TokenHasher` と同じ判断）。
 */
export class WebCryptoClaimCodeService implements ClaimCodeService {
  generate(): string {
    const bytes = new Uint8Array(CLAIM_CODE_LENGTH);
    crypto.getRandomValues(bytes);
    // 256 は 32 の倍数なので `% 32` でも一様。棄却サンプリングは要らない。
    let out = "";
    for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
    return out;
  }

  async hash(code: string): Promise<string> {
    // 入力の揺れ（大文字・前後の空白）はここでは吸収しない。
    // 吸収は Presentation 層で行い、ここは受け取った文字列をそのまま扱う。
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(code));
    return toHex(digest);
  }
}
