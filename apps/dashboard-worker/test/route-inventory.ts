/**
 * この Worker が持つルートの一覧。**手で書く。**
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
 *     キーと比べる。チェーンに乗っていないルートはここに出ないので、
 *     **乗り損ねを検知する。**
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
 */
export const EXPECTED_ROUTES = [
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

/** 一覧に載っているパス（重複を畳んだ union）。型側の突き合わせに使う。 */
export type ExpectedRoutePath = (typeof EXPECTED_ROUTES)[number]["path"];
