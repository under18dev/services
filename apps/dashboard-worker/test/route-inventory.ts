/**
 * この Worker が持つルートの一覧。**手で書く。**
 *
 * **2 つに分けてある。** `API_ROUTES` は `hono/client` のチェーンに乗る
 * JSON の経路、`PAGE_ROUTES` は HTML を返す画面とアセット。
 * 分ける理由は `PAGE_ROUTES` の JSDoc を参照。
 *
 * ## なぜ手で書いた一覧が要るのか
 *
 * `test/client-type.test-d.ts` は `hono/client` の型が空でないことを
 * 固定しているが、**「以後に足すルートがチェーンに乗ること」は守れない**
 * （#188 のレビューで指摘された）。新しいルートを文で分けて書いても、
 * 既存のルートの型は残るので test-d は全部通り、**新しいルートだけが
 * 静かにクライアントの型から漏れる。**
 *
 * そこでこの一覧を 1 つ置き、**2 方向から**突き合わせる:
 *
 *  1. **実行時**（`route-inventory.test.ts`）—— `createApp().routes` と比べる。
 *     チェーンの外に書いたルートもここには出るので、**追加を必ず検知する。**
 *  2. **型**（`client-type.test-d.ts`）—— `DashboardAppType` のスキーマの
 *     キーを `API_ROUTES` と比べる。チェーンに乗っていないルートはここに
 *     出ないので、**乗り損ねを検知する。** 逆に画面をチェーンへ足した
 *     ときも、`API_ROUTES` に無いものが出るので止まる。
 *
 * 1 だけ通って 2 が落ちたら、それは「チェーンの外に書いた」という意味である。
 *
 * ## ルートを足したら、ここにも 1 行足すこと
 *
 * 足さないと 1 が落ちる。**それがこの仕組みの目的である** —— 一覧の更新を
 * 強制することで、チェーンに乗っているかどうかを 2 の側に判定させる。
 *
 * `wrangler.jsonc` の route と `ACCOUNT_BASE_PATH` を突き合わせている
 * `route-config.test.ts` と同じ形（設定とコードのドリフト検査）。
 *
 * ## 型側の結果は `pnpm test` ではなく `pnpm typecheck` に出る
 *
 * `vitest.config.ts` の `include` は `test/**​/*.test.ts` なので、
 * **`client-type.test-d.ts` は vitest では 1 件も実行されない。** 型検査
 * （`tsc -p tsconfig.json` が `test/**​/*.ts` を拾う）でだけ走る。
 *
 * つまり**型テストを足しても `pnpm test` の件数は増えない。** 落ちるときも
 * Test ジョブではなく Typecheck ジョブが赤くなる。意図してそうしている
 * （`@ts-expect-error` が「抑制すべきエラーが無い」で落ちる仕組みも tsc 側）
 * が、知らないと「書いたのに走っていない」に見える。
 */
export const API_ROUTES = [
  { method: "GET", path: "/account/health" },
  { method: "GET", path: "/account/api/me" },
  { method: "PATCH", path: "/account/api/me" },
  { method: "GET", path: "/account/api/me/sessions" },
  { method: "DELETE", path: "/account/api/me/sessions/:id" },
  { method: "GET", path: "/account/api/me/passkeys" },
  { method: "DELETE", path: "/account/api/me/passkeys/:id" },
  { method: "GET", path: "/account/api/me/grants" },
  { method: "DELETE", path: "/account/api/me/grants/:clientId" },
] as const;

/**
 * HTML を返す画面と、そこから読むアセット（#9）。
 *
 * **こちらはチェーンに乗せない。** `hc` はブラウザが直接開くページを
 * 呼ばないので、型に積んでも使い道が無く、型を読む人には雑音になる。
 *
 * 分けてあることで**「乗せるべきものが乗っていない」と「乗せるべきで
 * ないものが乗っている」の両方**を型側が見られる。`API_ROUTES` と
 * ちょうど一致することを確かめているので、画面をうっかりチェーンへ
 * 足すとそこで止まる。
 */
export const PAGE_ROUTES = [
  { method: "GET", path: "/account" },
  { method: "GET", path: "/account/sessions" },
  { method: "GET", path: "/account/grants" },
  { method: "GET", path: "/account/ui/u18.css" },
  { method: "GET", path: "/account/ui/account-island.js" },
] as const;

/** 実行時に登録されているべきもの全部。 */
export const EXPECTED_ROUTES = [...API_ROUTES, ...PAGE_ROUTES];

/** **チェーンに乗るべき**パス（重複を畳んだ union）。型側の突き合わせに使う。 */
export type ApiRoutePath = (typeof API_ROUTES)[number]["path"];
