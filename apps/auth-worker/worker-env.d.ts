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
  /** ID Token 署名用の秘密鍵 (JWK JSON)。Phase 2 で使用。 */
  readonly SIGNING_KEY_JWK?: string;
  /** 上記鍵の kid。Phase 2 で使用。 */
  readonly SIGNING_KEY_KID?: string;
  /** IP アドレスのハッシュ化に混ぜる pepper。環境ごとに異なる値にする。 */
  readonly IP_HASH_PEPPER?: string;
  /** メール送信プロバイダのキー（仕様書 14-3 で選定）。 */
  readonly EMAIL_API_KEY?: string;
}
