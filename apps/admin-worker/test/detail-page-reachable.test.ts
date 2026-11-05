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

/**
 * 「詳細ページはあるが、一覧のどこからもリンクされていない」穴（#502）。
 *
 * `asset-coverage.test.ts` の ISLAND_PATH 検査は「`data-*` を使う画面が
 * アイランドを読んでいるか」しか見ておらず、**一覧 → 詳細の導線そのもの**
 * は見ていない——`/clients` の一覧に `/clients/:clientId` へのリンクが
 * 1 本も無いまま本番に出ていたのに、どの検査も気づかなかった。
 *
 * `NAV_PAGE_ROUTES`（`route-inventory.ts`）にある `:param` 詳細ページ
 * それぞれについて、対応する一覧の HTML に実際の href が含まれることを
 * 確かめる。次に詳細ページを増やした人がここへ 1 行足し忘れても、
 * このテスト自体は落ちない——そこは `route-inventory.test.ts` と同じ
 * 「一覧に足すのは手で」という前提に乗っている。ここで保証するのは
 * **足した行について、本当にリンクが張られているか**。
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

  const CASES: ReadonlyArray<{
    readonly listPath: string;
    readonly detailPath: string;
  }> = [
    { listPath: "/nfc", detailPath: `/nfc/${TARGET_CARD_ID}` },
    { listPath: "/clients", detailPath: `/clients/${TARGET_CLIENT_ID}` },
    { listPath: "/users", detailPath: `/users/${TARGET_USER_ID}` },
  ];

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
