import { DEV_SESSION_COOKIE_NAME, rpcOk } from "@u18/contracts";
import type { GrantListItem, PasskeySummary, SessionListItem, UserProfile } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import {
  classesIn,
  classesMissingFrom,
  darkMediaVarNames,
  deliveredBorderRadius,
  gdgShadowTokenDefs,
  shadowDeclsWithClay,
} from "@u18/testing";
import { GDG_DARK_CLASS_VAR_NAMES, hashedFileName } from "@u18/web-ui";
import { KIWA_STYLESHEET_PATH, OVERVIEW_PATH } from "../src/presentation/http/ui/asset-paths";
import { PAGES } from "./pages";
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
    appUrl: null,
    // **scope の箇条書きはここでしか出ない。**
    scopes: ["openid", "profile", "email"],
    grantedAt: "2026-10-29T00:00:00.000Z",
  },
  {
    clientId: "u18-second",
    clientName: "もう 1 つのアプリ",
    logoUrl: null,
    appUrl: null,
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
 * **一覧は `ui-pages.test.ts` と共有している**（`./pages`）。あちらは
 * 「どのスタイルシートを読むか」、ここは「読んだ CSS に class が在るか」で、
 * 同じ 6 枚を別の角度から見ている。**片方にしか無い画面があると、
 * その画面だけ片目で見ていることになる**（理由は `./pages` の冒頭）。
 */

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

  it("フォントもアイコンも外から読まない（自前配信する Google Sans を除く）", async () => {
    // 仕様書 §14.1 決定 15。第三者ホストから読むと CSP に外部ホストを
    // 足すことになり、**画面を開いた事実がそのホストへ渡る。** 上流の
    // `globals.css` は Inter を rsms.me から読んでいたので、落とし忘れが
    // ここで止まる。
    //
    // **「0 個」ではなく「既知の 1 個が相対パスであること」を見る**
    // （design-system 連携、PR2）。Google Sans の自前配信が `@font-face`
    // の `url()` を 1 つ持ち込むようになったため。
    const css = await fetchText(KIWA_STYLESHEET_PATH, false);

    const urls = [...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^"\.\/[^/"]+"$/);
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

  /**
   * モバイルのサイドバー開閉（#399 の作り直し）。
   *
   * **「class が CSS に在る」だけでは、#399 の事故は捕まえられない。**
   * 旧版の `group-open:flex` も CSS には在った——`[open]` が付いたときに
   * しか効かない形で在っただけで、`<summary>` を `md:hidden` にしたことで
   * PC では `[open]` へ至る手段ごと消えていた。「在る」と「何にも阻まれず
   * 効く」は別なので、ここでは `md:flex` の**ルールの形**を見る。
   */
  it("md:flex は何にも阻まれず効く（:checked や [open] に守られていない）", async () => {
    const css = await fetchText(KIWA_STYLESHEET_PATH, false);

    // Tailwind v4 は `md:` を `@media (min-width:48rem)` にまとめる。
    const mediaMatch = css.match(/@media \(min-width:48rem\)\{([^]*)/);
    expect(mediaMatch, "md: のメディアクエリが見当たらない").not.toBeNull();

    const mdFlexRule = mediaMatch?.[1]?.match(/\.md\\:flex\{([^}]*)\}/)?.[0];
    expect(mdFlexRule, "md:flex のルールが見当たらない").toBeDefined();
    // プレーンな `.md\:flex{display:flex}` であること。`:checked` や
    // `[open]` のような状態セレクタが前に付いていたら、それは「PC でも
    // 閉じていたら消える」形に戻っている。
    expect(mdFlexRule).toBe(".md\\:flex{display:flex}");
  });

  /**
   * design.md の "No gradients."。上流の `.bg-primary-mesh` は
   * `linear-gradient` だったので持ってきていない（#332 からの決定）。
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
    const css = await fetchText(KIWA_STYLESHEET_PATH, false);

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
 * 本文の幅をページごとに変えない（運用者の直接の要望）。
 *
 * `KiwaShell` はかつて `maxWidth` prop を持っていた（この Worker の
 * 6 画面は全部既定の `max-w-3xl` のままだったが、admin の 7 画面が
 * `max-w-6xl` を渡しており、**同じ `KiwaShell` なのに画面によって本文の
 * 幅が違う**という指摘そのもの）。prop ごと外したので、ここでは
 * **型だけの保証で終わっていないか**——実際に配信される HTML に
 * `max-w-` が残っていないかを見る。
 *
 * `PAGES`（6 枚）に加え、未認証の `message-page.tsx` も見る——`current`
 * を渡していないだけで、本文ラッパは同じ `KiwaShell` を通る。
 */
describe("本文の幅はページごとに変えない（運用者の直接の要望）", () => {
  /** `<main>` 直下の本文ラッパ div の class 属性。見つからなければ null。 */
  function bodyWrapperClassOf(html: string): string | null {
    return /<main[^>]*>\s*<div class="([^"]*)"/.exec(html)?.[1] ?? null;
  }

  function expectNoMaxWidth(html: string, label: string): void {
    const wrapperClass = bodyWrapperClassOf(html);
    // null のまま下の not.toMatch へ進むと、ラッパが見つからなくても
    // 「max-w- を含まない」側として緑になりうる。
    expect(wrapperClass, `${label}: <main> 直下の本文ラッパが見つからない`).not.toBeNull();
    expect(wrapperClass, `${label}: 本文ラッパに max-w- が付いている`).not.toMatch(/max-w-/);
  }

  it.each(PAGES)("%s の本文ラッパに max-w- が無い", async (path) => {
    const html = await fetchText(path, true);
    expectNoMaxWidth(html, path);
  });

  it("未認証で返る画面の本文ラッパにも max-w- が無い", async () => {
    const html = await fetchText(OVERVIEW_PATH, false, 401);
    expectNoMaxWidth(html, "message-page");
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
    const css = await fetchText(KIWA_STYLESHEET_PATH, false);
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
    const css = await fetchText(KIWA_STYLESHEET_PATH, false);
    const decls = shadowDeclsWithClay(css);

    // 0 件のまま下の assert へ進むと、何も確かめずに緑になる。
    expect(
      decls.length,
      "配信 CSS に --gdg-shadow-* を合成した shadow-* ユーティリティが見当たらない——" +
        "theme.css の --shadow-* から var(--gdg-shadow-*) が外れたか、" +
        "card.tsx / alert.tsx / empty.tsx / island-classes.ts の shadow-* クラスが " +
        "@source の走査から漏れている可能性がある。",
    ).toBeGreaterThan(0);

    for (const decl of decls) {
      expect(decl, `輪郭(0 0 0 1px)を失った shadow 合成: ${decl}`).toMatch(/0 0 0 1px/);
    }
  });

  it("--gdg-shadow-sm/md/lg トークン自体に、クレイの inset ハイライトが残っている（ライト・ダーク両方）", async () => {
    const css = await fetchText(KIWA_STYLESHEET_PATH, false);
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
    const css = await fetchText(KIWA_STYLESHEET_PATH, false);
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

/**
 * 角丸の対応表が、GDG の実コンポーネントが実際に使っている段と合っているか
 * （GDG デザイン移行 PR4、issue #535）。
 *
 * PR1 の対応表は 2 回目の間違いだった——`--radius-lg` に GDG 自身の
 * `tailwind.css` 内部の命名をそのまま持ち込んだ結果、GDG が実際には使って
 * いない 28px がボタン・入力欄に入っていた（vendored `../gdg/
 * components.css` の `.gdg-button`/`.gdg-input` は `--gdg-radius-md` = 18px、
 * `.gdg-card` が `--gdg-radius-card` = 28px）。`theme.css` の
 * `@theme inline` 側のコメントに根拠の行番号を書いたが、**対応表はこれで
 * 2 回ズレている**ので、配信 CSS の実測で固定する。
 */
describe("配信する CSS に、角丸の対応表が GDG の実値どおりに出ている", () => {
  it("rounded-lg（ボタン・入力欄）が --gdg-radius-md 由来、rounded-xl（カード）が --gdg-radius-card 由来", async () => {
    const css = await fetchText(KIWA_STYLESHEET_PATH, false);

    const roundedLg = deliveredBorderRadius(css, "rounded-lg");
    const roundedXl = deliveredBorderRadius(css, "rounded-xl");

    // null のまま下の比較へ進むと、見つからなかったことに気づけない。
    expect(roundedLg, "配信 CSS に .rounded-lg が見当たらない").not.toBeNull();
    expect(roundedXl, "配信 CSS に .rounded-xl が見当たらない").not.toBeNull();

    expect(roundedLg).toBe("var(--gdg-radius-md)");
    expect(roundedXl).toBe("var(--gdg-radius-card)");
  });
});
