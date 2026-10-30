import { DEV_SESSION_COOKIE_NAME, rpcOk } from "@u18/contracts";
import type { GrantListItem, UserProfile } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { classesIn, classesMissingFrom } from "@u18/testing";
import { hashedFileName } from "@u18/web-ui";
import { APPS_PATH, KIWA_STYLESHEET_PATH } from "../src/presentation/http/ui/asset-paths";
import { ORIGIN, envWith, executionContext } from "./helpers";

/**
 * Kiwa UI の画面が**使っているクラスの CSS を配信できているか**（#332）。
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
 * ここでは画面が実際に吐いた class を 1 つずつ、配信する CSS の中に
 * セレクタとして在るかで見ている。**人が目で見るまで分からない**という
 * 性質を、ここで潰しておく。
 *
 * ## 「在る」の見方
 *
 * 突き合わせは `@u18/testing` の `classesMissingFrom`。**2 つの Worker で
 * 同じものを使う** —— 最初は各 Worker に書いていて、実体参照の戻し方が
 * 不完全なまま**片方だけ緑だった**（あちらの冒頭）。
 */

const PROFILE: UserProfile = {
  id: "usr_test",
  username: "taro",
  displayName: "Taro",
  email: "taro@example.com",
  emailVerified: true,
  status: "active",
  isAdmin: false,
  createdAt: "2026-10-24T00:00:00.000Z",
};

const IDENTITY = {
  getUserProfile: async () => rpcOk(PROFILE),
  listGrants: async () => rpcOk([] as GrantListItem[]),
};

async function fetchText(path: string, withSession: boolean): Promise<string> {
  const response = await createApp().fetch(
    new Request(
      `${ORIGIN}${path}`,
      withSession ? { headers: { Cookie: `${DEV_SESSION_COOKIE_NAME}=token-value` } } : {},
    ),
    envWith(IDENTITY as never),
    executionContext(),
  );
  expect(response.status, `${path} が ${response.status}`).toBe(200);
  return await response.text();
}

describe("Kiwa の画面が使うクラスは、配信する CSS に在る", () => {
  it("/account/apps の class が 1 つ残らず CSS にある", async () => {
    const [html, css] = await Promise.all([
      fetchText(APPS_PATH, true),
      fetchText(KIWA_STYLESHEET_PATH, false),
    ]);

    const classes = classesIn(html);
    // 0 件だと**何も確かめずに通る。**
    expect(classes.length).toBeGreaterThan(20);

    const missing = classesMissingFrom(html, css);
    expect(
      missing,
      `CSS に無いクラス。theme.css にトークンが無いか、@source の走査から` +
        `漏れたファイルで組み立てている（apps/dashboard-worker/src/presentation/http/ui/kiwa.css）。`,
    ).toEqual([]);
  });

  it("フォントもアイコンも外から読まない", async () => {
    // 仕様書 §14.1 決定 15。第三者ホストから読むと CSP に外部ホストを
    // 足すことになり、**画面を開いた事実がそのホストへ渡る。** 上流の
    // `globals.css` は Inter を rsms.me から読んでいたので、落とし忘れが
    // ここで止まる。
    const css = await fetchText(KIWA_STYLESHEET_PATH, false);

    expect([...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1])).toEqual([]);
  });

  it("URL のハッシュが、配信した本文そのものから出ている", async () => {
    /*
     * **#332 で一番危なかったところ。** `asset-hash.ts` は「配信する文字列
     * そのものから実行時にハッシュを計算する」設計で、理由は #132 ——
     * ビルドにハッシュを吐かせると**生成物とハッシュがずれる余地**が残り、
     * ブラウザから見ると「中身が変わったのに URL が同じ」になる。
     *
     * Tailwind はふつうファイルを吐くので、素直に繋ぐとこの性質が壊れる。
     * **壊れていないことをここで見ている** —— 返ってきた本文から
     * `hashedFileName` を計算し直し、配信している URL と突き合わせる。
     * ビルドが古い CSS を書いたら URL も古いほうのハッシュになるので、
     * この 2 つがずれることは無い。ずれていたら、どこかがハッシュを
     * **別の入力から**作っている。
     */
    const css = await fetchText(KIWA_STYLESHEET_PATH, false);

    expect(KIWA_STYLESHEET_PATH).toBe(`/account/ui/${hashedFileName("kiwa.css", css)}`);
  });

  it("グラデーションを使わない", async () => {
    // design.md の "No gradients."。上流の `.bg-primary-mesh` は
    // `linear-gradient` だったので持ってきていない。
    //
    // **`*-gradient(` で見る。** Tailwind は `bg-linear-to-r` のような
    // ユーティリティ**の定義**を、使われていなければ出力しない。
    const css = await fetchText(KIWA_STYLESHEET_PATH, false);

    expect(css).not.toMatch(/(linear|radial|conic)-gradient\(/);
  });
});
