import { DEV_SESSION_COOKIE_NAME, rpcOk } from "@u18/contracts";
import type { GrantListItem, PasskeySummary, SessionListItem, UserProfile } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { classesIn, classesMissingFrom } from "@u18/testing";
import { hashedFileName } from "@u18/web-ui";
import {
  APPS_PATH,
  GRANTS_PATH,
  KIWA_STYLESHEET_PATH,
  OVERVIEW_PATH,
  PASSKEYS_PATH,
  PROFILE_PATH,
  SESSIONS_PATH,
} from "../src/presentation/http/ui/asset-paths";
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

/**
 * **一覧を空で返さない。**
 *
 * 0 件の画面は「ありません」の 1 行しか描かないので、**行まわりの class
 * （`island-classes.ts` の 8 つ）とバッジ・区切り・scope の箇条書きが
 * 1 つも HTML に出ない。** 実測で踏んだ —— `grants-page.tsx` の scope の
 * `<ul>` に存在しない class を足しても、一覧を空にしたままでは
 * この検査が緑のままだった。**「6 枚を引いている」と「6 枚の中身を
 * 引いている」は別である。**
 *
 * 0 件のほうの見た目（`EMPTY_CLASS` / `Empty`）は `ui-island.test.ts` と
 * `ui-pages.test.ts` が別に見ている。
 */
const PASSKEYS: PasskeySummary[] = [
  {
    id: "pk_test",
    label: "MacBook の Touch ID",
    deviceType: "platform",
    createdAt: "2026-10-24T00:00:00.000Z",
    lastUsedAt: "2026-10-29T00:00:00.000Z",
  },
  // **2 件目を入れる。** 区切り（`Separator`）は「1 件目の前に置かない」
  // ので、1 件だけだと描かれない。
  {
    id: "pk_two",
    label: null,
    deviceType: null,
    createdAt: "2026-10-25T00:00:00.000Z",
    lastUsedAt: null,
  },
];

const SESSIONS: SessionListItem[] = [
  {
    sessionId: "ses_current",
    createdAt: "2026-10-29T00:00:00.000Z",
    lastSeenAt: "2026-10-30T00:00:00.000Z",
    expiresAt: "2026-10-31T00:00:00.000Z",
    // **「このデバイス」のバッジはここでしか出ない。**
    current: true,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  },
  {
    sessionId: "ses_other",
    createdAt: "2026-10-28T00:00:00.000Z",
    lastSeenAt: "2026-10-28T00:00:00.000Z",
    expiresAt: "2026-10-31T00:00:00.000Z",
    current: false,
    userAgent: null,
  },
];

const GRANTS: GrantListItem[] = [
  {
    clientId: "u18-third-party",
    clientName: "テストアプリ",
    logoUrl: null,
    // **scope の箇条書きはここでしか出ない。**
    scopes: ["openid", "profile", "email"],
    grantedAt: "2026-10-29T00:00:00.000Z",
  },
  {
    clientId: "u18-second",
    clientName: "もう 1 つのアプリ",
    logoUrl: null,
    scopes: ["openid"],
    grantedAt: "2026-10-28T00:00:00.000Z",
  },
];

const IDENTITY = {
  getUserProfile: async () => rpcOk(PROFILE),
  listPasskeys: async () => rpcOk(PASSKEYS),
  listSessions: async () => rpcOk(SESSIONS),
  listGrants: async () => rpcOk(GRANTS),
};

/**
 * 6 枚とも引く（#332）。
 *
 * **1 枚だけでは足りない。** P0 のあいだは Kiwa の画面が `/account/apps`
 * しか無かったのでここも 1 枚だったが、P1 で 6 枚とも移ったあとも
 * 1 枚のままだった。**`/account/grants` の `<ul>` に存在しない class を
 * 足しても、この Worker の 277 本が全部通った**（実測）。
 *
 * `ui-pages.test.ts` の `PAGES` と同じ並びにしてある。**あちらは
 * 「どのスタイルシートを読むか」、ここは「読んだ CSS に class が在るか」**
 * で、同じ 6 枚を別の角度から見ている。
 */
const PAGES = [OVERVIEW_PATH, PROFILE_PATH, PASSKEYS_PATH, SESSIONS_PATH, GRANTS_PATH, APPS_PATH];

async function fetchText(
  path: string,
  withSession: boolean,
  /**
   * 期待する状態コード。
   *
   * **既定は 200 のまま。** 未認証の画面（`message-page.tsx`）は 401 で
   * 返るが、そこだけ明示させる —— 既定を「何でもよい」にすると、
   * **引けていない応答から class を拾って 0 件で通る**形が入りうる。
   */
  status = 200,
): Promise<string> {
  const response = await createApp().fetch(
    new Request(
      `${ORIGIN}${path}`,
      withSession ? { headers: { Cookie: `${DEV_SESSION_COOKIE_NAME}=token-value` } } : {},
    ),
    envWith(IDENTITY as never),
    executionContext(),
  );
  expect(response.status, `${path} が ${response.status}`).toBe(status);
  return await response.text();
}

describe("Kiwa の画面が使うクラスは、配信する CSS に在る", () => {
  it.each(PAGES)("%s の class が 1 つ残らず CSS にある", async (path) => {
    const [html, css] = await Promise.all([
      fetchText(path, true),
      fetchText(KIWA_STYLESHEET_PATH, false),
    ]);

    const classes = classesIn(html);
    // 0 件だと**何も確かめずに通る。**
    expect(classes.length, `${path} が class を 1 つも吐いていない`).toBeGreaterThan(20);

    const missing = classesMissingFrom(html, css);
    expect(
      missing,
      `${path}: CSS に無いクラス。theme.css にトークンが無いか、@source の走査から` +
        `漏れたファイルで組み立てている（apps/dashboard-worker/src/presentation/http/ui/kiwa.css）。`,
    ).toEqual([]);
  });

  it("一覧が ui-pages.test.ts の PAGES を漏れなく覆っている", () => {
    // 画面を足して**ここに書き忘れる**と、上の `it.each` が静かに
    // その画面を見なくなる。`ui-pages.test.ts` が同じ仕掛けを持っている。
    expect(PAGES.length).toBe(6);
    expect(new Set(PAGES).size, "同じパスが 2 回入っている").toBe(PAGES.length);
  });

  /**
   * **未認証の画面も見る**（`message-page.tsx`）。
   *
   * `SignInRequiredPage` は 6 つの URL すべてから返る共通の画面で、
   * **Cookie を付けて引く上の `it.each` は 1 度も通らない。**
   * `ui-pages.test.ts` が「未認証でもスタイルシートは 1 本」を見ているが、
   * **その 1 本の中に class が在るか**はここでしか見ていない。
   */
  it("未認証で返る画面の class も CSS にある", async () => {
    const [html, css] = await Promise.all([
      fetchText(OVERVIEW_PATH, false, 401),
      fetchText(KIWA_STYLESHEET_PATH, false),
    ]);

    expect(html, "未認証の画面ではない").toContain("ログイン");
    expect(classesIn(html).length).toBeGreaterThan(5);
    expect(classesMissingFrom(html, css)).toEqual([]);
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
