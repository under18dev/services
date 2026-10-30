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
  // **概要から切り出した 2 枚**（#308）。サイドバーを置くと 1 画面 1 主題に
  // しないと「どの項目が現在地か」を決められない。
  { method: "GET", path: "/account/profile" },
  { method: "GET", path: "/account/passkeys" },
  { method: "GET", path: "/account/sessions" },
  { method: "GET", path: "/account/grants" },
  // u18 Identity で使えるアプリのカタログ（#308）。**`/account/grants` とは
  // 別物** —— あちらは「自分が同意した RP」、こちらは「運用側が載せた
  // アプリ」の案内（全件ではない）。中身はコードに持っているが
  // （`ui/app-catalog.ts`）、公開面としては画面が 1 枚増えている。
  { method: "GET", path: "/account/apps" },
  // **ハッシュは手で書けないので `<hash>` と書く**（#211）。突き合わせる
  // 側が実際のパスを正規化してから比べる。**ハッシュが入らなくなったら、
  // 正規化しても `<hash>` にならないのでここで落ちる。**
  // Kiwa UI のスタイルシート（#332）。**この Worker が配信する唯一の
  // スタイルシートである** —— 6 枚とも Kiwa へ移り、手書きの `u18.css` は
  // 誰も読まなくなったので消した。
  { method: "GET", path: "/account/ui/kiwa.<hash>.css" },
  { method: "GET", path: "/account/ui/account-island.<hash>.js" },
] as const;

/** 実行時に登録されているべきもの全部。 */
/**
 * ハッシュ付きアセット。`PAGE_ROUTES` から導く（別に書かない）。
 */
export const ASSET_ROUTES = PAGE_ROUTES.filter((route) => route.path.includes("/ui/"));

/** HTML を返す画面。アセット以外の `PAGE_ROUTES`。 */
export const HTML_PAGE_ROUTES = PAGE_ROUTES.filter((route) => !route.path.includes("/ui/"));

/**
 * **本番のアセット検査が引くページ**（`scripts/smoke-asset-probe.sh` の
 * `probe_pages_for`）。**あちらと一致していなければならない** ——
 * `check-asset-probe-pages.mjs` が突き合わせている。
 *
 * `/account` はこの Worker の入口で、未ログインでも 401 と一緒に画面を返す。
 */
export const PROBE_PAGES: readonly string[] = ["/account"];

/**
 * **外からは確かめられないアセット**と、その理由（#313）。
 *
 * ## なぜ要るのか
 *
 * 本番のアセット検査は**未認証で**ページを引く。この Worker の画面は
 * **未認証だと全部 401 でログイン導線を返す**（実測。`/account` も
 * `/account/passkeys` も `/account/sessions` も、参照するのは CSS だけ）。
 *
 * **つまりアイランドは、どのページを引いても外からは見えない。**
 * ログインして初めて参照されるものなので、ページの選び方では解決しない ——
 * 最初これを `/account/passkeys` への差し替えで直せると考えたが、
 * **本番で引いて確かめたら何も変わっていなかった。**
 *
 * ## 黙って外れるのと、宣言して外れるのは違う
 *
 * ここに書かないと「外から確かめられていないアセット」が一覧から消える。
 * 書いてあれば、**アイランドの配信が壊れても本番検査は気づかない**ことが
 * 読んだ人に伝わる。代わりに `asset-coverage.test.ts` が、**ログインした
 * 状態でレンダリングして**参照されていることを確かめている。
 */
/**
 * **`kiwa.<hash>.css` はここから外れた**（#332 の P1）。
 *
 * P0 のあいだは「読むのは `/account/apps` だけで、未認証だとログイン導線
 * （手書き CSS）が返る」ため外から確かめられなかった。いまはログイン導線
 * （`message-page.tsx`）も Kiwa なので、**`PROBE_PAGES` を未認証で引けば
 * 本番でも見える。**
 */
export const EXTERNALLY_UNVERIFIABLE_ASSETS: Readonly<Record<string, string>> = {
  "/account/ui/account-island.<hash>.js":
    "アイランドを読むのはログイン後の画面だけ。未認証では全ページが 401 で" +
    "ログイン導線を返し、参照するのは CSS だけである（本番で実測）。" +
    "ページの選び方では外から見えるようにできない。",
};

export const EXPECTED_ROUTES = [...API_ROUTES, ...PAGE_ROUTES];

/** **チェーンに乗るべき**パス（重複を畳んだ union）。型側の突き合わせに使う。 */
export type ApiRoutePath = (typeof API_ROUTES)[number]["path"];
