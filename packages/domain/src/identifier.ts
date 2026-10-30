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

/**
 * NFC カードの ID（`https://go.under18.dev/c/<id>` の `<id>`）。
 *
 * ## ここだけ既定の 16 バイトではない
 *
 * **20 バイト = 100 ビット。** スキーマ（`packages/nfc-db/src/schema/cards.ts`）、
 * README、脅威モデル §3.7 が揃って「100bit 相当」と書いている値で、
 * **本番だけが既定の 16 バイト（80 ビット）を作っていた**（#358 で発覚）。
 * 長さが 2 箇所に別々に書かれていたのが原因なので、**両方がここを呼ぶ**形に
 * して、文書の言う値と実装が離れられないようにした。
 *
 * ## なぜ長さが効くのか
 *
 * #358 で紐づけコードを廃止したので、**カード ID が唯一の秘密**になった。
 * それ以前の脅威モデルは「カード ID（100bit）と紐づけコード（80bit）の
 * **両方**を当てる必要がある」と書いており、そのうち 80 ビットのほうが
 * 無くなっている。**残る 1 本を、文書より短いまま使わない。**
 *
 * 80 ビットでも総当たりは現実的でない（nfc-worker にレート制限が無い
 * 前提で、1 万枚・毎秒 1 万回でも 3.8 億年）。**危険だったから伸ばすのでは
 * なく、決めてあった値へ戻している。**
 */
export const newCardId = (): string => newId("nfc", 20);
