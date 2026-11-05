import { rpcOk } from "@u18/contracts";
import { collectAssetRefs, normalizeAssetHash } from "@u18/web-ui";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { ISLAND_PATH } from "../src/presentation/http/ui/asset-paths";
import {
  ASSET_ROUTES,
  EXTERNALLY_UNVERIFIABLE_ASSETS,
  NAV_PAGE_ROUTES,
  PENDING_ROUTES,
  PROBE_PAGES,
} from "./route-inventory";
import {
  executionContext,
  fakeApprovals,
  loginAs,
  minimalIdentityAdmin,
  minimalNfcCards,
  ORIGIN,
} from "./helpers";

/**
 * アセット → ページの向き（#313、#447、#470）。
 *
 * ## すでにある検査では足りない
 *
 * - `route-inventory.test.ts` は**登録されているか**を見る。アセットの
 *   ルートが実在することは分かるが、**どこかのページがそれを参照して
 *   いるか**は見ていない
 * - `scripts/smoke-asset-probe.sh` は**ページ → アセット**の向き。
 *   ページに書いてある URL を本番で引くので、**ページが参照しなくなった
 *   アセットは、はじめから視界に入らない**
 *
 * #447 自体がこの両方の穴に落ちていた —— CSS の配信ルートが無くても、
 * どちらの検査も気づけなかった。`PROBE_PAGES`（`/callback`）が実際に
 * その CSS を参照していることを、手元のレンダリングで確かめる。
 *
 * ## `/callback` は 200 ではなく 400 を返す
 *
 * state も code も付けずに裸で叩くと `fail("missing_code_or_state")` が
 * `MessagePage`（Kiwa UI）を **400** で返す（`app.tsx`）。本文は返るので
 * 参照は読める——auth-worker / dashboard-worker の同名ファイルは 200 を
 * 期待しているが、ここだけ合わせて 400 にする。
 *
 * ## アイランドは `EXTERNALLY_UNVERIFIABLE_ASSETS` に宣言した（#470）
 *
 * CSS と違い、アイランドはログイン後の画面だけが読む。`PROBE_PAGES`
 * （未認証の `/callback`）からは見えないので、`dashboard-worker` と
 * 同じ形で「全画面（ログイン込み）を合わせれば覆える」ことを別に見る。
 */

const EXPECTED_ASSETS = ASSET_ROUTES.map((route) => normalizeAssetHash(route.path)).sort();

describe("本番検査が引くページで、アセットを全部覆える", () => {
  it("一覧にアセットがある", () => {
    // 0 件だと下のテストが**何も確かめずに通る。**
    expect(EXPECTED_ASSETS.length).toBeGreaterThan(0);
  });

  it("PROBE_PAGES が空でない", () => {
    expect(PROBE_PAGES.length).toBeGreaterThan(0);
  });

  it("外から確かめられないアセットには理由が書いてある", () => {
    for (const [asset, reason] of Object.entries(EXTERNALLY_UNVERIFIABLE_ASSETS)) {
      expect(EXPECTED_ASSETS, `${asset} は一覧に無い`).toContain(asset);
      // 空で通すと「確かめられない」が「確かめなくてよい」にすり替わる。
      expect(reason.trim().length, `${asset}: 理由が短すぎる`).toBeGreaterThan(20);
    }
  });

  it("PROBE_PAGES の参照だけで、宣言した範囲ちょうどを覆う", async () => {
    const seen = new Set<string>();
    for (const page of PROBE_PAGES) {
      const response = await createApp().fetch(
        new Request(`${ORIGIN}${page}`),
        env,
        executionContext(),
      );
      // 400 でなければ参照が読めない。**0 件と区別が付かない**ので先に落とす。
      expect(response.status, `${page} が 400 を返さない`).toBe(400);
      for (const ref of collectAssetRefs(await response.text())) seen.add(ref);
    }

    const declaredUnverifiable = Object.keys(EXTERNALLY_UNVERIFIABLE_ASSETS);
    const expectedVisible = EXPECTED_ASSETS.filter(
      (asset) => !declaredUnverifiable.includes(asset),
    );

    expect(
      [...seen].sort(),
      `PROBE_PAGES（${PROBE_PAGES.join(" ")}）を引いたときに見えるアセットが、` +
        `EXTERNALLY_UNVERIFIABLE_ASSETS の宣言と噛み合っていません。`,
    ).toEqual(expectedVisible);
  });
});

describe("ログイン後の画面を合わせると、アイランドまで覆える", () => {
  /**
   * アイランドを読む 3 画面（#470: `/audit` `/clients` `/nfc/analytics`）
   * だけを引く。**`/nfc` `/users` `/approvals` は引かない**——こちらが見るのは
   * 「`EXPECTED_ASSETS` を過不足なく覆っているか」で、fake を増やすと
   * 「このテストが見たいもの」がぼやける。
   *
   * **`/nfc` `/users` `/users/:userId` に `ISLAND_PATH` が無いこと自体は、
   * この後の「data-* を使う画面は ISLAND_PATH も読む」が全画面に対して
   * 見ている。** 実際に #471 がその 3 画面へ `data-sortable` 等を足した
   * 時点で `ISLAND_PATH` を読んでおらず、本番でコピーボタン・絞り込み欄が
   * 永久に `hidden` のままだった（指摘: 3b、#480 のレビューで発覚）。
   */
  it("/audit /clients /nfc/analytics の参照が、宣言したアセットを全部覆う", async () => {
    const seen = new Set<string>();
    const sub = "usr_asset_coverage";
    const approvals = fakeApprovals([sub]);
    const overrides = {
      approvals,
      // `minimalNfcCards()` の `unused()` は**同期的に** throw する。
      // `/nfc/analytics` は `Promise.allSettled([container.nfcCards.
      // tapTimeseries(...), ...])` と**配列リテラルの中で直接呼ぶ**ので、
      // 同期 throw は allSettled に届く前に配列の組み立てごと落ちる
      // （本物の binding は常に Promise を返すので起きない、テスト専用の
      // 事情）。6 本とも空応答で解決する fake に差し替える。
      nfcCards: {
        ...minimalNfcCards(),
        tapTimeseries: async () =>
          rpcOk({
            dailyTotals: [],
            totalTaps: 0,
            dailyAverage: 0,
            maxDay: null,
            retentionDays: 180,
          }),
        usageFunnel: async () =>
          rpcOk({ issued: 0, claimedEver: 0, tappedEver: 0, retentionDays: 180 }),
        batchAnalytics: async () => rpcOk({ rows: [] }),
        cardUsageRanking: async () => rpcOk({ ranking: [], dormant: { count: 0, rows: [] } }),
        disabledReasonBreakdown: async () => rpcOk({ rows: [] }),
        transferCountDistribution: async () => rpcOk({ zero: 0, one: 0, two: 0, threeOrMore: 0 }),
      },
      // `/clients` は `listOAuthClients` を同期的に待つ（allSettled の外）
      // ので、`minimalIdentityAdmin()` の `unused()` のままだと 500 になる。
      identityAdmin: { ...minimalIdentityAdmin(), listOAuthClients: async () => rpcOk([]) },
    };
    const cookie = await loginAs(sub, approvals, overrides);

    for (const path of ["/audit", "/clients", "/nfc/analytics"]) {
      const response = await createApp(overrides).fetch(
        new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } }),
        env,
        executionContext(),
      );
      expect(response.status, `${path} が 200 を返さない`).toBe(200);
      for (const ref of collectAssetRefs(await response.text())) seen.add(ref);
    }

    expect([...seen].sort()).toEqual(expect.arrayContaining(EXPECTED_ASSETS));
  });
});

/**
 * `data-sortable` / `data-filter` / `data-copy` / `data-tabs` を使う画面は、
 * `ISLAND_PATH` も読んでいること（指摘: 3b、#480 のレビューで発覚）。
 *
 * ## 片方だけ足せる状態が本体の問題
 *
 * `data-copy` の付いたボタンも `data-filter` の付いた入力欄も、**サーバーは
 * `hidden` で描き、JS が外す約束**（`ui/client/README.md` の絶対条件）。
 * アイランドを読まない画面にこの属性だけ足すと、**要素は一生 `hidden` の
 * ままで、運用者からは「そもそも無い」のと区別が付かない。**
 *
 * 実際に、#471 が `nfc-page.tsx` / `users-page.tsx` / `user-detail-page.tsx`
 * へこの属性を足した時点ではまだ `ISLAND_PATH` 自体が存在せず（#470 より
 * 前にマージされたため）、#470 が後から `ISLAND_PATH` を作ったときに
 * この 3 画面を見直す仕組みが無かった。レビューでも見逃された。
 *
 * ## 決め打ちで直すのではなく、全画面を実際にレンダリングして突き合わせる
 *
 * `route-inventory.ts` の `NAV_PAGE_ROUTES`（承認済みの管理者が辿り着く
 * 全 GET ページ）を実際に引き、**属性が 1 つでもあれば `ISLAND_PATH` も
 * あること**を見る。新しい画面が `data-copy` 等を足したときに、ここが
 * 自動で気づく——`route-inventory.test.ts` が「登録されているルート」を
 * 二方向で突き合わせているのと同じ考え方。
 */
describe("data-sortable / data-filter / data-copy / data-tabs を使う画面は、必ず ISLAND_PATH も読む", () => {
  const TARGET_USER_ID = "usr_island_coverage_target";
  const TARGET_CLIENT_ID = "app_island_coverage_target";
  const TARGET_CARD_ID = "nfc_island_coverage_target";

  /**
   * **0 件ではなく 1 件を返す。** `data-sortable` / `data-filter` /
   * `data-copy` は一覧が空のときは出ない画面がほとんど（`cards.length
   * === 0` 等の分岐で空状態の文言に差し替わる）——0 件のまま検査すると、
   * どの画面も属性を 1 つも出さないまま「ISLAND_PATH が無くても通る」
   * 検査になってしまう。実際、最初にこの検査を書いたときは 0 件のままで
   * 書いてしまい、`nfc-page.tsx` から `scripts` を一時的に外しても検査が
   * 落ちなかった（ネガティブ確認で気づいた）。
   */
  function overridesFor(approvals: ReturnType<typeof fakeApprovals>) {
    const card = {
      cardId: TARGET_CARD_ID,
      status: "active" as const,
      ownerUserId: TARGET_USER_ID,
      targetUrl: "https://go.under18.dev/c/nfc_island_coverage",
      batch: null,
      issuedAt: "2026-01-01T00:00:00.000Z",
      claimedAt: "2026-01-02T00:00:00.000Z",
      disabledAt: null,
    };
    const user = {
      id: TARGET_USER_ID,
      username: "island-coverage",
      displayName: "Island Coverage",
      primaryEmail: "island-coverage@example.test",
      emailVerified: true,
      status: "active" as const,
      hasAdminFlag: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const client = {
      clientId: TARGET_CLIENT_ID,
      name: "Island Coverage Client",
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
      id: "aud_island_coverage",
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
        // カード詳細（#472、`/nfc/:cardId`）も NAV_PAGE_ROUTES にあるので対象。
        getCard: async () =>
          rpcOk({
            ...card,
            transferCount: 0,
            disabledReason: null,
            tapCount: 0,
            lastTappedAt: null,
          }),
        cardTapHistory: async () =>
          rpcOk({
            dailyTotals: [],
            totalTaps: 0,
            retentionDays: 180,
            lastTappedAt: null,
            daysSinceLastTap: null,
            last7d: { total: 0, previousTotal: 0 },
            last30d: { total: 0, previousTotal: 0 },
          }),
        tapTimeseries: async () =>
          rpcOk({
            dailyTotals: [],
            totalTaps: 0,
            dailyAverage: 0,
            maxDay: null,
            retentionDays: 180,
          }),
        usageFunnel: async () =>
          rpcOk({ issued: 0, claimedEver: 0, tappedEver: 0, retentionDays: 180 }),
        batchAnalytics: async () => rpcOk({ rows: [] }),
        cardUsageRanking: async () => rpcOk({ ranking: [], dormant: { count: 0, rows: [] } }),
        disabledReasonBreakdown: async () => rpcOk({ rows: [] }),
        transferCountDistribution: async () => rpcOk({ zero: 0, one: 0, two: 0, threeOrMore: 0 }),
      },
      identityAdmin: {
        ...minimalIdentityAdmin(),
        listUsers: async () => rpcOk({ users: [user], nextCursor: null }),
        getUser: async () => rpcOk(user),
        listOAuthClients: async () => rpcOk([client]),
        getOAuthClient: async () => rpcOk(client),
        listAuditLogs: async () => rpcOk({ entries: [auditEntry], nextCursor: null }),
      },
    };
  }

  it("NAV_PAGE_ROUTES の全 GET ページで、属性が無いか ISLAND_PATH もあるかのどちらか", async () => {
    const sub = "usr_island_coverage";
    const approvals = fakeApprovals([sub]);
    const overrides = overridesFor(approvals);
    const cookie = await loginAs(sub, approvals, overrides);

    const paths = NAV_PAGE_ROUTES.filter((route) => route.method === "GET").map((route) =>
      route.path
        .replace(":userId", TARGET_USER_ID)
        .replace(":clientId", TARGET_CLIENT_ID)
        .replace(":cardId", TARGET_CARD_ID),
    );
    // 0 件だと下の assertion が何も確かめずに通る。
    expect(paths.length).toBeGreaterThan(0);

    const MARKERS = ["data-sortable", "data-filter", "data-copy", "data-tabs"];
    const pagesWithMarkers: string[] = [];

    for (const path of paths) {
      const response = await createApp(overrides).fetch(
        new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } }),
        env,
        executionContext(),
      );
      expect(response.status, `${path} が 200 を返さない`).toBe(200);

      const html = await response.text();
      const usesIslandAttr = MARKERS.some((marker) => html.includes(marker));
      if (usesIslandAttr) {
        pagesWithMarkers.push(path);
        expect(
          html,
          `${path} は data-sortable/data-filter/data-copy/data-tabs のいずれかを使うのに、ISLAND_PATH を読んでいない`,
        ).toContain(ISLAND_PATH);
      }
    }

    // **属性を 1 つも見なかったら、上のループは何も確かめずに通っている。**
    // 1 件ずつ fake を用意したのはこのため——0 件のままだと空状態の文言に
    // 差し替わり、どの画面も属性を出さない（このテストを書いた直後に
    // ネガティブ確認で踏んだ）。
    expect(
      pagesWithMarkers.length,
      "どのページも data-sortable/data-filter/data-copy/data-tabs を含んでいない——fake のデータが空のままになっていないか確認すること",
    ).toBeGreaterThan(0);
  });

  /**
   * `/pending` は `NAV_PAGE_ROUTES` に入らない（指摘: 3b、#488 で発覚）。
   *
   * **承認済みの管理者が辿る画面ではなく、未承認の人だけが見る画面**
   * だから——`route-inventory.ts` の区分がそう決めている。上のテストは
   * `NAV_PAGE_ROUTES` だけを引くので、`/pending` に `data-copy` を足して
   * `ISLAND_PATH` を忘れても、上のテストは気づかずに緑のまま通る。
   *
   * **`NAV_PAGE_ROUTES` へ `/pending` を足すのは違う。** あの一覧は
   * `check-app-catalog-routes.mjs` が `ADMIN_NAV_GROUPS`（サイドバーの
   * 並び）と突き合わせる意味も持っており、`/pending` はサイドバーに
   * 出ない画面——意味の違う一覧へ押し込むと、次に読む人が「承認済みの
   * 画面の一覧」という前提を疑わなくなる。別のテストとして、同じ確認を
   * `PENDING_ROUTES` にも足す。
   */
  it("PENDING_ROUTES も同様——/pending も data-* を使うなら ISLAND_PATH を読む", async () => {
    const sub = "usr_pending_island_coverage";
    const approvals = fakeApprovals([]); // 未承認のまま。
    const cookie = await loginAs(sub, approvals);

    const paths = PENDING_ROUTES.filter((route) => route.method === "GET").map(
      (route) => route.path,
    );
    expect(paths.length).toBeGreaterThan(0);

    const MARKERS = ["data-sortable", "data-filter", "data-copy", "data-tabs"];
    let sawMarker = false;

    for (const path of paths) {
      const response = await createApp({ approvals }).fetch(
        new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } }),
        env,
        executionContext(),
      );
      expect(response.status, `${path} が 200 を返さない`).toBe(200);

      const html = await response.text();
      if (MARKERS.some((marker) => html.includes(marker))) {
        sawMarker = true;
        expect(
          html,
          `${path} は data-sortable/data-filter/data-copy/data-tabs のいずれかを使うのに、ISLAND_PATH を読んでいない`,
        ).toContain(ISLAND_PATH);
      }
    }

    // 属性を 1 つも見なかったら、上のループは何も確かめずに通っている
    // （上の NAV_PAGE_ROUTES 版と同じ注意）。
    expect(
      sawMarker,
      "/pending が data-sortable/data-filter/data-copy/data-tabs を 1 つも含んでいない",
    ).toBe(true);
  });
});
