import { SELF } from "cloudflare:test";
import {
  classesIn,
  classesMissingFrom,
  darkMediaVarNames,
  gdgShadowTokenDefs,
  shadowDeclsWithClay,
} from "@u18/testing";
import { GDG_DARK_CLASS_VAR_NAMES, hashedFileName } from "@u18/web-ui";
import { beforeEach, describe, expect, it } from "vitest";
import { KIWA_STYLESHEET_PATH } from "../src/presentation/http/ui/asset-paths";
import { resetDatabase } from "./helpers";
import {
  PUBLIC_CLIENT_ID,
  createPkcePair,
  authorizeQuery,
  seedDefaultClients,
  seedLoggedInUser,
  sessionCookie,
} from "./helpers.oauth";
import { freshIpFactory } from "./fresh-ip";

/**
 * ログイン画面・同意画面が**使っているクラスの CSS を配信できているか**（#332）。
 *
 * dashboard-worker / nfc-worker と同じ形。3 つの Worker が**別々に
 * Tailwind を走らせている**（走査対象が違うので出力も違う）ので、
 * 片方にしか無い検査は片方でしか効かない。
 *
 * ## ここが一番危ない
 *
 * **本番のログイン経路そのもの**である。`theme.css` にトークンが無い、
 * `@source` の走査から漏れた、綴りを間違えた —— どれも **class は HTML に
 * 出るのに CSS が無い**で、状態コードも HTML も正しいまま、
 * **見た目だけが崩れる**（#320 と同じ形）。
 *
 * ログイン画面が崩れても**誰も入れなくなるわけではない**ので、
 * 外形監視にも出ない。だからここで見る。
 *
 * ## どこまで届いているか
 *
 * | 画面 | 覆えているか |
 * | --- | --- |
 * | `/login`・`/signup` の `email` | はい |
 * | `LoginView` の `code` | **いいえ**（`/login/start` を POST しないと出ない） |
 * | `LoginView` の `signed_in` | **いいえ**（セッション Cookie が要る） |
 * | 同意画面（`ConsentPage`） | はい（#332 の P2 で足した。下ごしらえが要る） |
 * | `AuthorizeErrorPage` | はい（未知の `client_id` で 400 が出る） |
 *
 * **ログイン画面の残り 2 つは実測で確かめてある。** `code` の `<h2>` に
 * 存在しない class を足してもこの検査は緑のままだった（`email` の `<h2>` に
 * 足すと落ちる）。塞ぐには `login.ui.test.ts` と同じ下ごしらえ（利用者の
 * seed、CSRF、OTP の発行）が要る。**全部を塞ぐより、どこが塞がって
 * いないかが読めるほうを採った** —— 足すときはあちらの helper を使うこと。
 *
 * 同意画面のほうは**その下ごしらえを実際に書いた**（`helpers.oauth.ts` の
 * seed を借りる）。あの画面は `styles.ts` の最後の持ち主で、Kiwa へ移した
 * 変更そのものを誰も見ていない状態になるのを避けたかったため。
 */

const BASE = "http://localhost";

/** `/oauth/authorize` には IP 単位のレート制限が掛かっている（#21）。 */
const freshIp = freshIpFactory("kiwa-stylesheet");

async function fetchText(
  path: string,
  options: { readonly cookie?: string; readonly status?: number } = {},
): Promise<string> {
  const headers: Record<string, string> = { "CF-Connecting-IP": freshIp() };
  if (options.cookie !== undefined) headers["Cookie"] = options.cookie;

  const response = await SELF.fetch(`${BASE}${path}`, { headers });
  expect(response.status, `${path} が ${response.status}`).toBe(options.status ?? 200);
  return await response.text();
}

/** 認可要求のクエリを組み立てる（`helpers.oauth.ts` の `authorize` は SELF を通らない）。 */
function authorizePath(overrides: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(authorizeQuery(overrides))) {
    if (value !== undefined) params.set(key, value);
  }
  return `/oauth/authorize?${params.toString()}`;
}

describe("画面が使うクラスは、配信する CSS に在る", () => {
  it("/login の class が 1 つ残らず CSS にある", async () => {
    const [html, css] = await Promise.all([fetchText("/login"), fetchText(KIWA_STYLESHEET_PATH)]);

    // 0 件だと**何も確かめずに通る。**
    expect(classesIn(html).length).toBeGreaterThan(15);

    expect(
      classesMissingFrom(html, css),
      "CSS に無いクラス。theme.css にトークンが無いか、@source の走査から" +
        "漏れたファイルで組み立てている（src/presentation/http/ui/kiwa.css）。",
    ).toEqual([]);
  });

  it("/signup の class も覆えている", async () => {
    // **同じ画面の mode 違いだが、出る要素が違う**（パスキーの導線が無い）。
    // 片方だけ見ると、もう片方にしか出ない class の抜けを拾えない。
    const [html, css] = await Promise.all([fetchText("/signup"), fetchText(KIWA_STYLESHEET_PATH)]);

    expect(classesMissingFrom(html, css)).toEqual([]);
  });

  it("URL のハッシュが、配信した本文そのものから出ている", async () => {
    // #211 / #132。ビルドにハッシュを計算させていないことを見ている。
    const css = await fetchText(KIWA_STYLESHEET_PATH);

    expect(KIWA_STYLESHEET_PATH).toBe(`/ui/${hashedFileName("kiwa.css", css)}`);
  });

  it("フォントもアイコンも外から読まない（自前配信する Google Sans を除く）", async () => {
    // 仕様書 §14.1 決定 15。**ログイン画面を開いた事実が第三者へ渡る**のを
    // 避けるための決定で、ここが一番それに近い画面である。
    //
    // **「0 個」ではなく「既知の 1 個が相対パスであること」を見る**
    // （design-system 連携、PR2）。Google Sans の自前配信が `@font-face`
    // の `url()` を 1 つ持ち込むようになったため。
    const css = await fetchText(KIWA_STYLESHEET_PATH);

    const urls = [...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^"\.\/[^/"]+"$/);
  });
});

/**
 * 同意画面は**下ごしらえが要る**。
 *
 * 妥当な認可要求（登録済みの third-party クライアント・登録済みの
 * `redirect_uri`・PKCE）と、ログイン済みのセッションが揃って初めて 200 で
 * 出る。`/login` のように GET 1 本では引けない —— これが「同意画面の
 * 検査が無かった」理由そのものである。
 */
describe("同意画面が使うクラスも、配信する CSS に在る", () => {
  beforeEach(resetDatabase);

  it("ConsentPage の class が 1 つ残らず CSS にある", async () => {
    await seedDefaultClients();
    const user = await seedLoggedInUser();
    const pkce = await createPkcePair();

    const html = await fetchText(
      authorizePath({ client_id: PUBLIC_CLIENT_ID, code_challenge: pkce.challenge }),
      { cookie: sessionCookie(user) },
    );

    // **同意画面が出ていることを先に確かめる。** リダイレクトでも
    // エラー画面でも `classesMissingFrom` は空を返すので、
    // 「引けていない」と「CSS が揃っている」が区別できなくなる。
    expect(html, "同意画面ではない HTML を見ている").toContain("へのアクセスを許可しますか？");
    expect(classesIn(html).length).toBeGreaterThan(10);

    const css = await fetchText(KIWA_STYLESHEET_PATH);
    expect(classesMissingFrom(html, css)).toEqual([]);
  });

  it("AuthorizeErrorPage の class も覆えている", async () => {
    // 未知の `client_id` は**リダイレクトせず**自前の画面で止まる
    // （RFC 6749 §4.1.2.1）。セッションも PKCE も要らない。
    const html = await fetchText(authorizePath({ client_id: "no-such-client" }), { status: 400 });

    expect(html).toContain("ログインを続行できません");

    const css = await fetchText(KIWA_STYLESHEET_PATH);
    expect(classesMissingFrom(html, css)).toEqual([]);
  });
});

/**
 * OS 設定（`prefers-color-scheme`）に従うライト/ダークが、**実際に配信
 * される CSS まで届いているか**（GDG デザイン移行 PR1、指摘: 3b）。
 *
 * `packages/web-ui/test/gdg-dark-media.test.ts` は `tokens.css` の `.dark`
 * と生成物（`generated/dark-media.css`）の変数名の集合が一致することを
 * 見ているが、それは**生成物の話**でしかない。`theme.css` の
 * `@import "../gdg/generated/dark-media.css"` を 1 行消しても、あちらの
 * テストは全部緑のまま通る——`@layer` の順序や Tailwind の
 * `optimize: true`（Lightning CSS）をくぐり抜けて、実際に配信される
 * バイト列に `@media (prefers-color-scheme: dark)` が残っているかは、
 * ここでしか見ていない。
 *
 * 「`prefers-color-scheme` という文字列が含まれる」だけでは弱い——ブロック
 * が残っていても中身が削られていたら気づけない。配信 CSS の @media が
 * 持つ変数名の集合を、vendored `tokens.css` の `.dark` が持つ集合と
 * 直接突き合わせる。
 */
describe("配信する CSS に、OS 設定に従うダークの @media が実際に届いている", () => {
  it("@media (prefers-color-scheme: dark) の変数名の集合が tokens.css の .dark と一致する", async () => {
    const css = await fetchText(KIWA_STYLESHEET_PATH);
    const delivered = darkMediaVarNames(css);

    // 0 件のまま下の比較へ進むと、空集合同士の一致で緑になりうる。
    expect(
      delivered.size,
      "配信 CSS に @media (prefers-color-scheme: dark) が見つからない——" +
        "theme.css の @import が外れたか、ビルドの途中で落ちている可能性がある。",
    ).toBeGreaterThan(0);

    // `tokens.css` を直接 readFileSync しない——workerd の中では読めない
    // （実測済み）。ビルド時に確定した配列を `@u18/web-ui` から import する。
    expect(GDG_DARK_CLASS_VAR_NAMES.length).toBeGreaterThan(0);

    expect([...delivered].sort()).toEqual([...GDG_DARK_CLASS_VAR_NAMES].sort());
  });
});

/**
 * クレイモーフィズムの影を重ねても、輪郭のリングと GDG の inset ハイライトが
 * 両方生きているか（GDG デザイン移行 PR3）。
 *
 * `theme.css` の `--shadow-sm` 等は `0 0 0 1px var(--border), var(--gdg-shadow-sm)`
 * の形でリングとクレイを合成している。Tailwind v4 の `shadow-*` ユーティリティは
 * 値の末尾の色を `--tw-shadow-color` へ静的に置き換えるため、多段 かつ inset を
 * 含む値を渡したときにこの分解が崩れていないかは実測でしか分からない
 * （`packages/testing/src/clay-shadow.ts` 参照）。
 */
describe("配信する CSS に、クレイの陰影とリングの輪郭が両方生きている", () => {
  it("shadow-* ユーティリティが --gdg-shadow-* を合成してもリング (0 0 0 1px) を失っていない", async () => {
    const css = await fetchText(KIWA_STYLESHEET_PATH);
    const decls = shadowDeclsWithClay(css);

    // 0 件のまま下の assert へ進むと、何も確かめずに緑になる。
    expect(
      decls.length,
      "配信 CSS に --gdg-shadow-* を合成した shadow-* ユーティリティが見当たらない——" +
        "theme.css の --shadow-* から var(--gdg-shadow-*) が外れたか、" +
        "card.tsx / alert.tsx / empty.tsx の shadow-* クラスが @source の走査から漏れている可能性がある。",
    ).toBeGreaterThan(0);

    for (const decl of decls) {
      expect(decl, `輪郭(0 0 0 1px)を失った shadow 合成: ${decl}`).toMatch(/0 0 0 1px/);
    }
  });

  it("--gdg-shadow-sm/md/lg トークン自体に、クレイの inset ハイライトが残っている（ライト・ダーク両方）", async () => {
    const css = await fetchText(KIWA_STYLESHEET_PATH);
    const tokenDefs = gdgShadowTokenDefs(css);

    // 0 件のまま下の assert へ進むと、何も確かめずに緑になる。
    expect(
      tokenDefs.length,
      "配信 CSS に --gdg-shadow-sm/md/lg のトークン定義が見当たらない。",
    ).toBeGreaterThan(0);

    // `.some()` だと、ダーク側の inset が丸ごと消えてもライト側の 3 件が
    // 残っていれば緑のまま通ってしまう（指摘: 3b）。全件を見る。
    for (const decl of tokenDefs) {
      expect(decl, `inset を失った --gdg-shadow-* トークン: ${decl}`).toContain("inset");
    }
  });

  it("--gdg-shadow-sm/md/lg が、ダークの @media の中にも実際に出ている", async () => {
    // #531 で一度踏んだ穴と同じ形——「count > 0」は何かを見つけたとしか
    // 言わず、見るべきものを見つけたとは言わない。ダークの @media の中身を
    // 直接見るのに、既に実績のある darkMediaVarNames を再利用する。
    const css = await fetchText(KIWA_STYLESHEET_PATH);
    const darkVars = darkMediaVarNames(css);

    expect(
      darkVars.size,
      "配信 CSS に @media (prefers-color-scheme: dark) が見つからない。",
    ).toBeGreaterThan(0);

    for (const name of ["--gdg-shadow-sm", "--gdg-shadow-md", "--gdg-shadow-lg"]) {
      expect(darkVars.has(name), `ダークの @media に ${name} が無い`).toBe(true);
    }
  });
});
