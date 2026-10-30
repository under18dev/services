import { SELF } from "cloudflare:test";
import { classesIn, classesMissingFrom } from "@u18/testing";
import { hashedFileName } from "@u18/web-ui";
import { describe, expect, it } from "vitest";
import { KIWA_STYLESHEET_PATH } from "../src/presentation/http/ui/asset-paths";

/**
 * ログイン画面が**使っているクラスの CSS を配信できているか**（#332）。
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
 * ## 覆えているのは 4 つの見え方のうち 2 つだけ
 *
 * `LoginView` は `email` / `code` / `signed_in` の 3 つ、さらに
 * `mode` が `login` / `signup` に分かれる。**ここが引けるのは GET で
 * 出せる 2 つ**（`/login` の email と `/signup` の email）だけである。
 *
 *  - **`code`** —— `/login/start` を POST しないと出ない
 *  - **`signed_in`** —— セッション Cookie が要る
 *
 * **実測で確かめてある。** `code` の `<h2>` に存在しない class を足しても
 * この検査は緑のままだった（`email` の `<h2>` に足すと落ちる）。
 *
 * 塞ぐには `login.ui.test.ts` と同じ下ごしらえ（利用者の seed、CSRF、
 * OTP の発行）が要る。**全部を塞ぐより、どこが塞がっていないかが
 * 読めるほうを採った** —— 足すときはあちらの helper を使うこと。
 */

const BASE = "http://localhost";

async function text(path: string): Promise<string> {
  const response = await SELF.fetch(`${BASE}${path}`);
  expect(response.status, `${path} が ${response.status}`).toBe(200);
  return await response.text();
}

describe("ログイン画面が使うクラスは、配信する CSS に在る", () => {
  it("/login の class が 1 つ残らず CSS にある", async () => {
    const [html, css] = await Promise.all([text("/login"), text(KIWA_STYLESHEET_PATH)]);

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
    const [html, css] = await Promise.all([text("/signup"), text(KIWA_STYLESHEET_PATH)]);

    expect(classesMissingFrom(html, css)).toEqual([]);
  });

  it("URL のハッシュが、配信した本文そのものから出ている", async () => {
    // #211 / #132。ビルドにハッシュを計算させていないことを見ている。
    const css = await text(KIWA_STYLESHEET_PATH);

    expect(KIWA_STYLESHEET_PATH).toBe(`/ui/${hashedFileName("kiwa.css", css)}`);
  });

  it("フォントもアイコンも外から読まない", async () => {
    // 仕様書 §14.1 決定 15。**ログイン画面を開いた事実が第三者へ渡る**のを
    // 避けるための決定で、ここが一番それに近い画面である。
    const css = await text(KIWA_STYLESHEET_PATH);

    expect([...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1])).toEqual([]);
  });
});
