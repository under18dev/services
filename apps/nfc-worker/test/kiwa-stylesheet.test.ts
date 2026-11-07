import { env } from "cloudflare:test";
import { classesIn, classesMissingFrom, darkMediaVarNames } from "@u18/testing";
import { GDG_DARK_CLASS_VAR_NAMES, hashedFileName } from "@u18/web-ui";
import { beforeEach, describe, expect, it } from "vitest";
import { CARDS_UI_PATH, createApp } from "../src/presentation/http/app";
import { KIWA_STYLESHEET_PATH } from "../src/presentation/http/ui/asset-paths";
import {
  ORIGIN,
  cookieFor,
  executionContext,
  identityWith,
  resetDatabase,
  seedActiveCard,
  seedIssuedCard,
} from "./helpers";

/**
 * カード画面が**使っているクラスの CSS を配信できているか**（#338）。
 *
 * **dashboard-worker の同名のテストと同じ形である。** 揃えてあるのは、
 * 2 つの Worker が**別々に Tailwind を走らせている**からで（走査対象が
 * 違うので出力も違う）、片方にしか無い検査は片方でしか効かない。
 *
 * ## これが無いと #320 が形を変えて戻る
 *
 * #320 は、インライン `style=` が CSP に捨てられて**本番でだけ**見た目が
 * 崩れた事故だった。HTML も状態コードも正しいままなので、応答を見ている
 * テストでは気づけない。
 *
 * Tailwind でも同じ形が作れる。**`theme.css` に無いトークンを使うと、
 * Tailwind はそのユーティリティを生成しない** —— `bg-success-soft` と
 * 書けば class は HTML に出るが、CSS には何も無い。綴りを間違えたとき、
 * `@source` の走査から漏れたファイルで class を組み立てたときも同じで、
 * **どれも静かに効かないだけ**である。
 *
 * **この Worker は `packages/web-ui` の primitives を読む**ので、
 * `kiwa.css` の `@source` が packages 側を指していないと、サイドバーと
 * カードの class だけが CSS を持たない状態になる。
 *
 * ## 「在る」の見方
 *
 * 突き合わせは `@u18/testing` の `classesMissingFrom`。**2 つの Worker で
 * 同じものを使う** —— 最初は各 Worker に書いていて、実体参照の戻し方が
 * 不完全なまま**片方だけ緑だった**（あちらの冒頭）。
 */

const TARO = "token-taro-0123456789abcdefghijklmn";
// **運営の画面はこの Worker に無い**（#433）。引くのは利用者向けの
// カード一覧と、公開の案内ページだけである。
const identity = identityWith({ [TARO]: "usr_taro" });

async function fetchText(path: string, cookie?: string): Promise<string> {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("Cookie", cookie);
  const response = await createApp({ identity }).fetch(
    new Request(`${ORIGIN}${path}`, { headers }),
    env,
    executionContext(),
  );
  expect(response.status, `${path} が ${response.status}`).toBe(200);
  return await response.text();
}

beforeEach(resetDatabase);

describe("カード画面が使うクラスは、配信する CSS に在る", () => {
  /**
   * **一覧が空の形と、埋まっている形の両方を見る。**
   *
   * 空のときは `Empty`、埋まっているときは `Card` / `Badge` /
   * `Separator` と、**出てくる primitive がまるごと違う。** 片方だけ
   * 見ると、もう片方でしか使わない class が CSS から落ちていても緑になる。
   */
  it.each([
    ["カードが無いとき", false],
    ["カードがあるとき", true],
  ])("%s の class が 1 つ残らず CSS にある", async (_label, seeded) => {
    if (seeded) {
      await seedActiveCard("usr_taro", "https://example.com/taro");
      // 無効化のバッジ（`destructive`）は有効なカードからは出ない。
      await seedIssuedCard();
    }

    const html = await fetchText(CARDS_UI_PATH, cookieFor(TARO));
    const css = await fetchText(KIWA_STYLESHEET_PATH);

    const classes = classesIn(html);
    // 0 件だと**何も確かめずに通る。**
    expect(classes.length).toBeGreaterThan(20);

    const missing = classesMissingFrom(html, css);
    expect(
      missing,
      `CSS に無いクラス。theme.css にトークンが無いか、@source の走査から` +
        `漏れたファイルで組み立てている（src/presentation/http/ui/kiwa.css）。`,
    ).toEqual([]);
  });

  it("URL のハッシュが、配信した本文そのものから出ている", async () => {
    /*
     * `asset-hash.ts` は「配信する文字列そのものから実行時にハッシュを
     * 計算する」設計で、理由は #132 —— ビルドにハッシュを吐かせると
     * **生成物とハッシュがずれる余地**が残り、ブラウザから見ると
     * 「中身が変わったのに URL が同じ」になる。
     *
     * Tailwind はふつうファイルを吐くので、素直に繋ぐとこの性質が壊れる。
     * **壊れていないことをここで見ている。**
     */
    const css = await fetchText(KIWA_STYLESHEET_PATH);

    expect(KIWA_STYLESHEET_PATH).toBe(`${CARDS_UI_PATH}/ui/${hashedFileName("kiwa.css", css)}`);
  });

  it("フォントもアイコンも外から読まない", async () => {
    // 仕様書 §14.1 決定 15。第三者ホストから読むと CSP に外部ホストを
    // 足すことになり、**画面を開いた事実がそのホストへ渡る。**
    const css = await fetchText(KIWA_STYLESHEET_PATH);

    expect([...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1])).toEqual([]);
  });

  /**
   * design.md の "No gradients."。
   *
   * **「0 個」ではなく「既知の 1 個を除いて 0 個」を見る**（GDG デザイン
   * 移行 PR1）。GDG の `../gdg/components.css` は無改変で置く約束
   * （`packages/web-ui/src/gdg/README.md`）で、中身を書き換えてグラデー
   * ションだけ消すことはできない。唯一のグラデーションは
   * `.gdg-skeleton:after`（読み込み中のシマー演出——単色の半透明を
   * 掃わせているだけで、design.md が禁じる "colorful" な演出とは別物）。
   * **`.gdg-skeleton` はこの PR のどの画面からも使われていない**
   * （`.tsx` を変えないのが PR1 の制約）ので、見た目には出ていない。
   *
   * `KNOWN_VENDORED_GRADIENT_SELECTORS` に無いセレクタでグラデーションが
   * 見つかったら落ちる——新しいグラデーションは引き続き捕まる。
   * `.gdg-skeleton` を実際に使い始めたら（PR3 以降）、ここを読み直して
   * この演出が design.md に合うか判断すること。
   */
  it("グラデーションを使わない（GDG の vendored components.css にある既知の 1 件を除く）", async () => {
    const css = await fetchText(KIWA_STYLESHEET_PATH);

    const KNOWN_VENDORED_GRADIENT_SELECTORS = [".gdg-skeleton:after"];

    const selectorsWithGradient = [
      ...css.matchAll(/([^{}]+)\{[^{}]*(?:linear|radial|conic)-gradient\([^{}]*\}/g),
    ].map((m) => (m[1] ?? "").trim());

    // 正規表現が壊れて 0 件のまま緑になる形を避ける——既知の 1 件は
    // 必ず見つかる前提で、まずそれ自体を確かめる。
    expect(
      selectorsWithGradient,
      "既知のグラデーション（.gdg-skeleton:after）が見つからない。" +
        "components.css の構造が変わったか、正規表現が壊れている可能性がある。",
    ).toContain(".gdg-skeleton:after");

    const unexpected = selectorsWithGradient.filter(
      (selector) => !KNOWN_VENDORED_GRADIENT_SELECTORS.includes(selector),
    );

    expect(unexpected, `想定外のグラデーション: ${unexpected.join(", ")}`).toEqual([]);
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
