import { rpcOk } from "@u18/contracts";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import {
  executionContext,
  fakeApprovals,
  loginAs,
  minimalIdentityAdmin,
  minimalNfcCards,
  ORIGIN,
} from "./helpers";
import { NAV_PAGE_ROUTES } from "./route-inventory";

/**
 * 「詳細ページはあるが、一覧のどこからもリンクされていない」穴（#502）。
 *
 * `asset-coverage.test.ts` の ISLAND_PATH 検査は「`data-*` を使う画面が
 * アイランドを読んでいるか」しか見ておらず、**一覧 → 詳細の導線そのもの**
 * は見ていない——`/clients` の一覧に `/clients/:clientId` へのリンクが
 * 1 本も無いまま本番に出ていたのに、どの検査も気づかなかった。
 *
 * **対象は手書きの配列にしない。** `NAV_PAGE_ROUTES` から `:param` を
 * 持つ GET ルートを拾い、末尾の `/:param` を落として一覧のパスを導く
 * （`/nfc/:cardId` → `/nfc`、`/clients/:clientId` → `/clients`、
 * `/users/:userId` → `/users`）。手書きの配列だと、次に詳細ページを
 * 足した人がここへの追記を忘れても検査が気づかない——今日 1 日で
 * 繰り返し踏んだ「宣言はあるが対象に入っていない」のと同じ形になる。
 *
 * 導いた各ルートに対応する具体的な ID は `DETAIL_PAGE_TARGETS` に持つ
 * （こちらは手書きせざるを得ない——どの文字列を fixture の ID として
 * 使うかは、ルールからは導けない）。**`NAV_PAGE_ROUTES` に新しい
 * `:param` 詳細ページが増えたのに `DETAIL_PAGE_TARGETS` へ足し忘れると、
 * この後の `.map` が例外で落ちる**——「見落としても緑のまま」ではなく
 * 「見落としたら落ちる」側に倒してある。
 */
describe("一覧から詳細ページへのリンクが実在する（#502）", () => {
  const TARGET_USER_ID = "usr_detail_link_target";
  const TARGET_CLIENT_ID = "app_detail_link_target";
  const TARGET_CARD_ID = "nfc_detail_link_target";

  function overrides() {
    const card = {
      cardId: TARGET_CARD_ID,
      status: "active" as const,
      ownerUserId: null,
      targetUrl: "https://go.under18.dev/c/nfc_detail_link_target",
      batch: null,
      issuedAt: "2026-01-01T00:00:00.000Z",
      claimedAt: null,
      disabledAt: null,
      tapCount: 0,
    };
    const user = {
      id: TARGET_USER_ID,
      username: "detail-link",
      displayName: "Detail Link Target",
      primaryEmail: "detail-link@example.test",
      emailVerified: true,
      status: "active" as const,
      hasAdminFlag: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const client = {
      clientId: TARGET_CLIENT_ID,
      name: "Detail Link Target Client",
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

    return {
      nfcCards: {
        ...minimalNfcCards(),
        listAllCards: async () => rpcOk({ cards: [card], truncated: false }),
      },
      identityAdmin: {
        ...minimalIdentityAdmin(),
        listUsers: async () => rpcOk({ users: [user], nextCursor: null }),
        listOAuthClients: async () => rpcOk([client]),
      },
    };
  }

  /** `NAV_PAGE_ROUTES` の `:param` 詳細ページごとの、具体的な fixture ID。 */
  const DETAIL_PAGE_TARGETS: Readonly<Record<string, string>> = {
    "/nfc/:cardId": TARGET_CARD_ID,
    "/clients/:clientId": TARGET_CLIENT_ID,
    "/users/:userId": TARGET_USER_ID,
  };

  const CASES: ReadonlyArray<{
    readonly listPath: string;
    readonly detailPath: string;
  }> = NAV_PAGE_ROUTES.filter((route) => route.method === "GET" && route.path.includes(":")).map(
    (route) => {
      const target = DETAIL_PAGE_TARGETS[route.path];
      if (target === undefined) {
        throw new Error(
          `${route.path} 用の fixture ID が DETAIL_PAGE_TARGETS に無い——NAV_PAGE_ROUTES に ` +
            "足したら、ここにも 1 行足すこと",
        );
      }
      return {
        listPath: route.path.replace(/\/:[^/]+$/, ""),
        detailPath: route.path.replace(/:[^/]+$/, target),
      };
    },
  );

  it("導出した対象が 0 件でない", () => {
    // 0 件だと下の it.each が何も実行せずに緑で通る。
    expect(CASES.length).toBeGreaterThan(0);
  });

  it.each(CASES)("$listPath に $detailPath へのリンクがある", async ({ listPath, detailPath }) => {
    const sub = "usr_detail_link_viewer";
    const approvals = fakeApprovals([sub]);
    const cookie = await loginAs(sub, approvals, overrides());

    const response = await createApp({ ...overrides(), approvals }).fetch(
      new Request(`${ORIGIN}${listPath}`, { headers: { Cookie: cookie } }),
      env,
      executionContext(),
    );
    expect(response.status, `${listPath} が 200 を返さない`).toBe(200);

    const html = await response.text();
    expect(html, `${listPath} に ${detailPath} へのリンクが無い`).toContain(`href="${detailPath}"`);
  });
});
