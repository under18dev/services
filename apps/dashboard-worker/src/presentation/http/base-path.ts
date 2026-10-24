/**
 * この Worker の全エンドポイントが載るベースパス（#106）。
 *
 * ## この値は `wrangler.jsonc` の `env.production.routes` と一致していなければならない
 *
 * route は `auth.under18.dev/account/*`。**Cloudflare の Workers route は
 * 一致判定しか行わず、一致した接頭辞を URL から取り除かない。**
 * つまり Worker には `/account/api/me` が**そのまま**届く。
 * ここを `/api/me` と登録すると、どのハンドラにも一致せず 404 になる。
 *
 * 逆に `auth.under18.dev/api/me` は、より短い pattern である auth-worker の
 * `auth.under18.dev/*` に吸われるので、こちらも dashboard には届かない。
 * **接頭辞を外すと、この Worker は本番で 1 つも叩けなくなる。**
 *
 * ## なぜ定数に切り出してあるのか
 *
 * `app.get("/account/api/me", ...)` と直接書くと、**route を触る人が
 * コードを読んでも「ここが `wrangler.jsonc` と結びついている」と気づく
 * 手掛かりが無い。** #106 はまさにそれで起きた（route を
 * `auth.under18.dev/account/*` に決めたとき、`src/index.ts` の
 * `app.get("/api/me")` を見ても何も引っかからなかった）。
 * 名前を付けておけば、`wrangler.jsonc` を触る人が grep で辿り着ける。
 * nfc-worker の `CARDS_BASE_PATH` と同じ形である。
 *
 * ## なぜ `src/index.ts` ではなくこのファイルに置くのか
 *
 * **Worker のエントリモジュールは、既定のハンドラと Entrypoint クラス以外の
 * 名前付き export を持てない。** 定数を `src/index.ts` から export すると
 * workerd が起動時に
 *   `Incorrect type for map entry 'ACCOUNT_BASE_PATH':
 *    the provided value is not of type 'function or ExportedHandler'`
 * で落ちる。
 *
 * **この失敗は vitest でも `wrangler deploy --dry-run` でも検出されない。**
 * 前者はモジュールを直接 import するだけで workerd の export 検査を通らず、
 * 後者はバンドルするだけでランタイムを起動しない。実際に
 * `wrangler dev` を立てて初めて分かった。定数をここへ戻すときは
 * 同じ落とし穴があることに注意すること。
 */
export const ACCOUNT_BASE_PATH = "/account";
