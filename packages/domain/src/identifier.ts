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
 * 公開される OIDC `client_id`（#333、運用者の判断で自動生成に変更）。
 *
 * **`newClientId()`（`oauth_clients.id`、内部 ID）とは別の値である。**
 * 同じ接頭辞にすると、`wrangler d1 execute` で行を見た運用者が
 * どちらの列か取り違える。
 *
 * **秘密ではない。** 認可 URL のクエリにそのまま載る値なので、
 * 推測困難性ではなく**衝突しないこと**だけが要る。既定の 16 バイト
 * （128 ビット）で十分 —— 誕生日攻撃を考慮しても、現実的な登録数
 * （多くて数百）では衝突確率は天文学的に低い。それでも
 * `oauth_clients_client_id_unique` が最後の砦として残っており、
 * 理論上の衝突は `conflict` に畳まれる（二度と起きないものとして
 * 無視するのではなく、起きても壊れない形にしてある）。
 */
export const newPublicClientId = (): string => newId("app");

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
const CARD_ID_PREFIX = "nfc";
const CARD_ID_BYTE_LENGTH = 20;

export const newCardId = (): string => newId(CARD_ID_PREFIX, CARD_ID_BYTE_LENGTH);

/**
 * `newCardId()` が作る形かどうかを見る（#365）。
 *
 * **以前は `apps/nfc-worker/src/presentation/http/` の 3 箇所が、それぞれ
 * `/^[a-z0-9_]{1,64}$/` という別のリテラルを持っていた。** 実際の ID の形
 * （`nfc_` + `ALPHABET` 20 文字 = ちょうど 24 文字）とは合っておらず、
 * 3 箇所が同じようにずれていた——直す必要が起きたとき、1 箇所直して
 * 残り 2 箇所を直し忘れる形になっていた。
 *
 * ここでは `newCardId()` と**同じ定数**（`CARD_ID_PREFIX` / `CARD_ID_BYTE_LENGTH`
 * / `ALPHABET`）からパターンを組み立てる。作る側と見る側が離れられない。
 *
 * ## これは防御ではない
 *
 * 呼び出し側（`redirect.routes.ts` 等）が既に書いている通り、ここで弾く
 * 目的は「形の違う入力で D1 を引きに行かない」という無駄打ちの抑制で
 * あり、セキュリティ上の境界ではない。**カード ID の形（接頭辞・長さ・
 * 文字集合）はこのファイルを読めば誰でも分かる、秘密ではない値**
 * ——厳しくしても、第三者に新しく教える情報は無い。
 *
 * 弾いた場合の応答を「実在しないカード」と変えないことは、呼び出し側
 * （`domain/services/disclosure.ts` を参照する経路）の責務のままである。
 */
const CARD_ID_PATTERN = new RegExp(`^${CARD_ID_PREFIX}_[${ALPHABET}]{${CARD_ID_BYTE_LENGTH}}$`);

export function isCardId(value: string): boolean {
  return CARD_ID_PATTERN.test(value);
}
