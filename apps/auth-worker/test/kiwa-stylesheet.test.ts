import { SELF } from "cloudflare:test";
import { classesIn, classesMissingFrom } from "@u18/testing";
import { hashedFileName } from "@u18/web-ui";
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

  it("フォントもアイコンも外から読まない", async () => {
    // 仕様書 §14.1 決定 15。**ログイン画面を開いた事実が第三者へ渡る**のを
    // 避けるための決定で、ここが一番それに近い画面である。
    const css = await fetchText(KIWA_STYLESHEET_PATH);

    expect([...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1])).toEqual([]);
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
