/**
 * Workers Secret として注入される値の型。
 *
 * `wrangler types` は wrangler.jsonc の vars しか見ないため、Secret は
 * ここで宣言してグローバルな `Env` にマージする。実値は `wrangler secret put` と
 * ローカルの .dev.vars で与える（.dev.vars.example を参照）。
 *
 * すべて optional にしてあるのは、未設定で起動しうるのが現実だから。
 * 「無ければ落とす / 既定値で進む」の判断は composition/container.ts で
 * 明示的に行う。
 */
interface Env {
  /**
   * ID Token 署名用の秘密鍵。次のどちらかの JSON を入れる。
   *
   * - **JWK Set**: `{"keys":[{...,"kid":"u18-2026-10-24-1"},{...}]}`
   *   新旧 2 鍵を同時に持てる（#23）。ローテーションはこちらで行う。
   * - **単一 JWK**: `{"kty":"EC","crv":"P-256","d":...}`
   *   #23 以前の形式。`SIGNING_KEY_KID` と対で使う。既存環境はそのまま動く。
   *
   * どの鍵で新規署名するかを決めるのは `signing_key_metadata` の
   * `active_from` / `active_until` であって、この Secret ではない。
   * Secret は「候補として持っている鍵の束」でしかない。
   */
  readonly SIGNING_KEY_JWK?: string;
  /**
   * 単一 JWK 形式のときの kid。
   *
   * **JWK Set 形式では参照されない**（各鍵が自分の `kid` を持つ）。
   * Set へ移行したら削除してよい。残っていても無視されるが、残すと
   * 「ここを変えれば署名鍵が変わる」と読まれるので消すこと。
   */
  readonly SIGNING_KEY_KID?: string;
  /** IP アドレスのハッシュ化に混ぜる pepper。環境ごとに異なる値にする。 */
  readonly IP_HASH_PEPPER?: string;
  /** メール送信プロバイダのキー（仕様書 14-3 で選定）。 */
  readonly EMAIL_API_KEY?: string;
}
