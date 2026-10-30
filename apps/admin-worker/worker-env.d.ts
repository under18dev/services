/**
 * Workers Secret として注入される値の型。
 *
 * `wrangler types` は wrangler.jsonc の vars しか見ないため、Secret は
 * ここで宣言してグローバルな `Env` にマージする。実値は `wrangler secret put` と
 * ローカルの .dev.vars で与える（.dev.vars.example を参照）。
 *
 * すべて optional にしてあるのは、未設定で起動しうるのが現実だから。
 * 「無ければ落とす」の判断は composition/container.ts で明示的に行う。
 */
interface Env {
  /**
   * u18 Identity に登録した OAuth クライアントの client_secret。
   *
   * `scripts/oauth-client.mjs create` が 1 度だけ出す値。confidential
   * クライアントとして登録した場合のみ要る——取りこぼすと再発行は
   * できず、クライアントを作り直すしかない（`docs/admin-worker-setup.md`）。
   */
  readonly OIDC_CLIENT_SECRET?: string;
  /**
   * admin-worker 自身のセッショントークンの署名鍵（HS256）。
   * 32 バイト以上のランダム値を base64 などで渡す。
   *
   * ローテーションすると、既存のセッションは一斉に無効になる
   * （HS256 は対称鍵が 1 本なので、鍵を 2 本持つ仕組みが無い）。
   */
  readonly SESSION_SECRET?: string;
}
