import { rpcOk } from "@u18/contracts";
import { env } from "cloudflare:test";
import {
  classesIn,
  classesMissingFrom,
  darkMediaVarNames,
  deliveredBorderRadius,
  gdgShadowTokenDefs,
  shadowDeclsWithClay,
} from "@u18/testing";
import { GDG_DARK_CLASS_VAR_NAMES, hashedFileName } from "@u18/web-ui";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { KIWA_STYLESHEET_PATH } from "../src/presentation/http/ui/asset-paths";
import {
  executionContext,
  fakeApprovals,
  loginAs,
  minimalIdentityAdmin,
  minimalNfcCards,
  ORIGIN,
} from "./helpers";
import { NAV_PAGE_ROUTES, ROOT_ROUTES } from "./route-inventory";

/**
 * Kiwa UI の画面が**使っているクラスの CSS を配信できているか**（#533）。
 *
 * auth/dashboard/nfc の 3 Worker には同じ観点のファイルが既にあるが、
 * admin-worker にだけ無かった——GDG デザイン移行（#531）のレビューで
 * services-2b が気づいた（`asset-coverage.test.ts` は「アセットとページの
 * 対応」という別の観点で、「画面が使う class が CSS に在るか」は見ていない）。
 * admin は 17 画面を持つ主役で、クラスの数も 4 Worker で最多——ここが
 * 自動で守られていないと、「class は HTML に出るのに CSS が無い」状態
 * （#320 と同じ形）が起きても次は誰も気づかない。
 *
 * ## ページの一覧は手書きしない
 *
 * `route-inventory.ts` の `ROOT_ROUTES` + `NAV_PAGE_ROUTES` から導く
 * （`detail-page-reachable.test.ts` と同じ考え方）。手書きの配列だと、
 * 新しい画面を足した人がここへの追記を忘れても検査が気づかない。
 * `:param` を持つ詳細ページは `DETAIL_PAGE_TARGETS` の具体的な ID で埋める
 * ——`NAV_PAGE_ROUTES` に新しい `:param` 画面が増えたのに追記を忘れると、
 * 下の `.map` が例外で落ちる（「見落としても緑のまま」ではなく
 * 「見落としたら落ちる」側に倒す）。
 *
 * `/pending`（未承認者向け）は `NAV_PAGE_ROUTES` に入らない別の認可状態
 * （`asset-coverage.test.ts` の同じ注意を参照）なので、別の `it` で見る。
 *
 * ## fixture は 0 件にしない
 *
 * `overridesFor` は `asset-coverage.test.ts` の同名の fixture を下敷きに
 * している——カード・利用者・クライアント・監査ログをそれぞれ 1 件ずつ
 * 持たせ、一覧が空のときの代替文言（空状態）だけで終わらないようにする。
 * `/approvals` だけは承認者を 2 人（super approver 1 人・そうでない人 1 人）
 * にしてある——super approver の行は権限ビットの編集フォームを出さず、
 * 代わりに「super approver を外す」ボタンと注記を出す（`approvals-page.tsx`）
 * ので、1 人だけだと super 側か通常側のどちらかの class しか見えない。
 */

const TARGET_USER_ID = "usr_kiwa_stylesheet_target";
const TARGET_CLIENT_ID = "app_kiwa_stylesheet_target";
const TARGET_CARD_ID = "nfc_kiwa_stylesheet_target";
const VIEWER_SUB = "usr_kiwa_stylesheet_viewer";
const OTHER_APPROVER_SUB = "usr_kiwa_stylesheet_other_approver";

/** `NAV_PAGE_ROUTES` の `:param` 詳細ページごとの、具体的な fixture ID。 */
const DETAIL_PAGE_TARGETS: Readonly<Record<string, string>> = {
  "/nfc/:cardId": TARGET_CARD_ID,
  "/clients/:clientId": TARGET_CLIENT_ID,
  "/users/:userId": TARGET_USER_ID,
};

const PAGES: readonly string[] = [
  ...ROOT_ROUTES.map((route) => route.path),
  ...NAV_PAGE_ROUTES.filter((route) => route.method === "GET").map((route) => {
    if (!route.path.includes(":")) return route.path;
    const target = DETAIL_PAGE_TARGETS[route.path];
    if (target === undefined) {
      throw new Error(
        `${route.path} 用の fixture ID が DETAIL_PAGE_TARGETS に無い——NAV_PAGE_ROUTES に ` +
          "足したら、ここにも 1 行足すこと",
      );
    }
    return route.path.replace(/:[^/]+$/, target);
  }),
];

function overridesFor(approvals: ReturnType<typeof fakeApprovals>) {
  const card = {
    cardId: TARGET_CARD_ID,
    status: "active" as const,
    ownerUserId: TARGET_USER_ID,
    targetUrl: "https://go.under18.dev/c/nfc_kiwa_stylesheet",
    batch: null,
    issuedAt: "2026-01-01T00:00:00.000Z",
    claimedAt: "2026-01-02T00:00:00.000Z",
    disabledAt: null,
    tapCount: 3,
  };
  const user = {
    id: TARGET_USER_ID,
    username: "kiwa-stylesheet",
    displayName: "Kiwa Stylesheet Coverage",
    primaryEmail: "kiwa-stylesheet@example.test",
    emailVerified: true,
    status: "active" as const,
    hasAdminFlag: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const client = {
    clientId: TARGET_CLIENT_ID,
    name: "Kiwa Stylesheet Coverage Client",
    clientType: "public" as const,
    isFirstParty: false,
    logoUrl: null,
    redirectUris: ["https://example.test/callback"],
    scopes: ["openid"],
    createdAt: "2026-01-01T00:00:00.000Z",
    disabledAt: null,
    ownerUserId: null,
    appUrl: null,
  };
  const auditEntry = {
    id: "aud_kiwa_stylesheet",
    event: "oauth.client.created",
    userId: TARGET_USER_ID,
    actor: "admin-worker",
    outcome: "success" as const,
    reason: null,
    metadata: null,
    ipHash: null,
    userAgent: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  return {
    approvals,
    nfcCards: {
      ...minimalNfcCards(),
      listAllCards: async () => rpcOk({ cards: [card], truncated: false }),
      listCardsByOwner: async () => rpcOk({ cards: [card] }),
      getCard: async () =>
        rpcOk({
          ...card,
          transferCount: 0,
          disabledReason: null,
          tapCount: 3,
          lastTappedAt: "2026-01-03T00:00:00.000Z",
        }),
      cardTapHistory: async () =>
        rpcOk({
          dailyTotals: [{ date: "2026-01-03", total: 3 }],
          totalTaps: 3,
          retentionDays: 180,
          lastTappedAt: "2026-01-03T00:00:00.000Z",
          daysSinceLastTap: 1,
          last7d: { total: 3, previousTotal: 1 },
          last30d: { total: 3, previousTotal: 1 },
        }),
      tapTimeseries: async () =>
        rpcOk({
          dailyTotals: [{ date: "2026-01-03", total: 3 }],
          totalTaps: 3,
          dailyAverage: 1,
          maxDay: { date: "2026-01-03", total: 3 },
          retentionDays: 180,
        }),
      usageFunnel: async () =>
        rpcOk({ issued: 5, claimedEver: 3, tappedEver: 2, retentionDays: 180 }),
      batchAnalytics: async () => rpcOk({ rows: [] }),
      cardUsageRanking: async () =>
        rpcOk({
          ranking: [{ cardId: TARGET_CARD_ID, batch: null, status: "active" as const, total: 3 }],
          dormant: {
            count: 1,
            rows: [
              {
                cardId: TARGET_CARD_ID,
                batch: null,
                claimedAt: "2026-01-02T00:00:00.000Z",
                status: "active" as const,
              },
            ],
          },
        }),
      disabledReasonBreakdown: async () => rpcOk({ rows: [{ reason: "lost", count: 1 }] }),
      transferCountDistribution: async () => rpcOk({ zero: 1, one: 1, two: 0, threeOrMore: 0 }),
    },
    identityAdmin: {
      ...minimalIdentityAdmin(),
      listUsers: async () => rpcOk({ users: [user], nextCursor: null }),
      getUser: async () => rpcOk(user),
      getUsersByIds: async () => rpcOk([user]),
      listOAuthClients: async () => rpcOk([client]),
      getOAuthClient: async () => rpcOk(client),
      countOAuthClients: async () => rpcOk(1),
      countUsers: async () => rpcOk({ active: 1, suspended: 0, deleted: 0 }),
      listAuditLogs: async () => rpcOk({ entries: [auditEntry], nextCursor: null }),
    },
  };
}

async function fetchCss(): Promise<string> {
  const response = await createApp().fetch(
    new Request(`${ORIGIN}${KIWA_STYLESHEET_PATH}`),
    env,
    executionContext(),
  );
  expect(response.status, `${KIWA_STYLESHEET_PATH} が ${response.status} を返す`).toBe(200);
  return await response.text();
}

describe("Kiwa の画面が使うクラスは、配信する CSS に在る", () => {
  it("一覧にページがある", () => {
    // 0 件だと下の it.each が何も確かめずに通る。
    expect(PAGES.length).toBeGreaterThan(0);
  });

  it.each(PAGES)("%s の class が 1 つ残らず CSS にある", async (path) => {
    const approvals = fakeApprovals([VIEWER_SUB, OTHER_APPROVER_SUB], [VIEWER_SUB]);
    const overrides = overridesFor(approvals);
    const cookie = await loginAs(VIEWER_SUB, approvals, overrides);

    const [pageResponse, css] = await Promise.all([
      createApp(overrides).fetch(
        new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } }),
        env,
        executionContext(),
      ),
      fetchCss(),
    ]);
    expect(pageResponse.status, `${path} が ${pageResponse.status} を返す`).toBe(200);
    const html = await pageResponse.text();

    const classes = classesIn(html);
    // 0 件だと**何も確かめずに通る。**
    expect(classes.length, `${path} が class を 1 つも吐いていない`).toBeGreaterThan(20);

    const missing = classesMissingFrom(html, css);
    expect(
      missing,
      `${path}: CSS に無いクラス。theme.css にトークンが無いか、@source の走査から` +
        "漏れたファイルで組み立てている（apps/admin-worker/src/presentation/http/ui/kiwa.css）。",
    ).toEqual([]);
  });

  /**
   * `/pending` は `NAV_PAGE_ROUTES` に入らない（未承認者だけが見る画面、
   * `asset-coverage.test.ts` の同じ注意を参照）ので別に見る。
   */
  it("/pending の class も CSS にある", async () => {
    const sub = "usr_kiwa_stylesheet_pending";
    const approvals = fakeApprovals([]);
    const cookie = await loginAs(sub, approvals);

    const [pageResponse, css] = await Promise.all([
      createApp().fetch(
        new Request(`${ORIGIN}/pending`, { headers: { Cookie: cookie } }),
        env,
        executionContext(),
      ),
      fetchCss(),
    ]);
    expect(pageResponse.status, `/pending が ${pageResponse.status} を返す`).toBe(200);
    const html = await pageResponse.text();

    expect(classesIn(html).length).toBeGreaterThan(20);
    expect(classesMissingFrom(html, css)).toEqual([]);
  });

  it("URL のハッシュが、配信した本文そのものから出ている", async () => {
    const css = await fetchCss();
    expect(KIWA_STYLESHEET_PATH).toBe(`/ui/${hashedFileName("kiwa.css", css)}`);
  });

  it("フォントもアイコンも外から読まない（自前配信する Google Sans を除く）", async () => {
    // 仕様書 §14.1 決定 15。第三者ホストから読むと CSP に外部ホストを
    // 足すことになり、**画面を開いた事実がそのホストへ渡る。**
    //
    // **「0 個」ではなく「既知の 1 個が相対パスであること」を見る**
    // （design-system 連携、PR2）。Google Sans の自前配信が `@font-face`
    // の `url()` を 1 つ持ち込むようになったため。
    const css = await fetchCss();

    const urls = [...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^"\.\/[^/"]+"$/);
  });

  /**
   * design.md の "No gradients."。
   *
   * **「0 個」ではなく「既知の 1 個を除いて 0 個」を見る**（GDG デザイン
   * 移行 PR1、#531）。GDG の `../gdg/components.css` は無改変で置く約束
   * （`packages/web-ui/src/gdg/README.md`）で、中身を書き換えてグラデー
   * ションだけ消すことはできない。唯一のグラデーションは
   * `.gdg-skeleton:after`（読み込み中のシマー演出）で、admin-worker の
   * どの画面からも使われていない（`.tsx` を変えないのが PR1 の制約）。
   *
   * `KNOWN_VENDORED_GRADIENT_SELECTORS` に無いセレクタでグラデーションが
   * 見つかったら落ちる——新しいグラデーションは引き続き捕まる。
   */
  it("グラデーションを使わない（GDG の vendored components.css にある既知の 1 件を除く）", async () => {
    const css = await fetchCss();

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
 * `KiwaShell` はかつて `maxWidth` prop を持ち、画面によって
 * `max-w-3xl`（768px）/`max-w-6xl`（1152px）が中央寄せで混在していた
 * ——「コンテンツの横幅が自由すぎる」という指摘そのもの。prop ごと
 * 外したので、ここでは**それが型だけの保証で終わっていないか**を見る。
 * typecheck は呼び出し側のコンパイルエラーを拾うだけで、実際に配信
 * される HTML に `max-w-` が残っていないかまでは見ない。
 *
 * **`<main>` 直下の本文ラッパ `<div>` だけを見る。** 画面の中身
 * （`empty.tsx` の `max-w-sm`、入力欄の `max-w-xs` など）が独自に
 * `max-w-*` を持つのは別の話で、ページ幅の話と混ぜると何を守りたい
 * 検査なのかがぼやける。
 */
describe("本文の幅はページごとに変えない（運用者の直接の要望）", () => {
  /** `<main>` 直下の本文ラッパ div の class 属性。見つからなければ null。 */
  function bodyWrapperClassOf(html: string): string | null {
    return /<main[^>]*>\s*<div class="([^"]*)"/.exec(html)?.[1] ?? null;
  }

  it.each(PAGES)("%s の本文ラッパに max-w- が無い", async (path) => {
    const approvals = fakeApprovals([VIEWER_SUB, OTHER_APPROVER_SUB], [VIEWER_SUB]);
    const overrides = overridesFor(approvals);
    const cookie = await loginAs(VIEWER_SUB, approvals, overrides);

    const response = await createApp(overrides).fetch(
      new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } }),
      env,
      executionContext(),
    );
    expect(response.status, `${path} が ${response.status} を返す`).toBe(200);
    const html = await response.text();

    const wrapperClass = bodyWrapperClassOf(html);
    // null のまま下の not.toMatch へ進むと、ラッパが見つからなくても
    // 「max-w- を含まない」側として緑になりうる。
    expect(wrapperClass, `${path}: <main> 直下の本文ラッパが見つからない`).not.toBeNull();
    expect(wrapperClass, `${path}: 本文ラッパに max-w- が付いている`).not.toMatch(/max-w-/);
  });

  it("/pending の本文ラッパにも max-w- が無い", async () => {
    const sub = "usr_kiwa_stylesheet_pending_width";
    const approvals = fakeApprovals([]);
    const cookie = await loginAs(sub, approvals);

    const response = await createApp().fetch(
      new Request(`${ORIGIN}/pending`, { headers: { Cookie: cookie } }),
      env,
      executionContext(),
    );
    expect(response.status, `/pending が ${response.status} を返す`).toBe(200);
    const html = await response.text();

    const wrapperClass = bodyWrapperClassOf(html);
    expect(wrapperClass, "/pending: <main> 直下の本文ラッパが見つからない").not.toBeNull();
    expect(wrapperClass, "/pending: 本文ラッパに max-w- が付いている").not.toMatch(/max-w-/);
  });
});

/**
 * OS 設定（`prefers-color-scheme`）に従うライト/ダークが、**実際に配信
 * される CSS まで届いているか**（GDG デザイン移行 PR1、#531、指摘: 3b）。
 * 元は `kiwa-dark-media.test.ts` という別ファイルだった——#531 の時点では
 * admin-worker に `kiwa-stylesheet.test.ts` 自体が無かったため。#533 で
 * このファイルを新設したので、他 3 Worker と同じ形（1 ファイルに同居）へ
 * 統合した。
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
 * 持つ変数名の集合を、vendored `tokens.css` の `.dark` が持つ集合
 * （`@u18/web-ui` の `GDG_DARK_CLASS_VAR_NAMES`、ビルド時に確定した配列）
 * と直接突き合わせる。
 */
describe("配信する CSS に、OS 設定に従うダークの @media が実際に届いている", () => {
  it("@media (prefers-color-scheme: dark) の変数名の集合が tokens.css の .dark と一致する", async () => {
    const css = await fetchCss();
    const delivered = darkMediaVarNames(css);

    // 0 件のまま下の比較へ進むと、空集合同士の一致で緑になりうる。
    expect(
      delivered.size,
      "配信 CSS に @media (prefers-color-scheme: dark) が見つからない——" +
        "theme.css の @import が外れたか、ビルドの途中で落ちている可能性がある。",
    ).toBeGreaterThan(0);

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
    const css = await fetchCss();
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
    const css = await fetchCss();
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
    const css = await fetchCss();
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
    const css = await fetchCss();

    const roundedLg = deliveredBorderRadius(css, "rounded-lg");
    const roundedXl = deliveredBorderRadius(css, "rounded-xl");

    // null のまま下の比較へ進むと、見つからなかったことに気づけない。
    expect(roundedLg, "配信 CSS に .rounded-lg が見当たらない").not.toBeNull();
    expect(roundedXl, "配信 CSS に .rounded-xl が見当たらない").not.toBeNull();

    expect(roundedLg).toBe("var(--gdg-radius-md)");
    expect(roundedXl).toBe("var(--gdg-radius-card)");
  });
});
