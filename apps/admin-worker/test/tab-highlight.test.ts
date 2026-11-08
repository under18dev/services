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
 * 選択中タブの視覚的な強調（指摘: 3b）。
 *
 * **実在する画面を fetch して見る。** `ui/client/admin-island.test.ts`
 * 側にも同じ主旨のテストがあるが、あちらは `tsconfig.client.json`
 * （DOM 型だけ、`Env` 等の ambient 型が無い）の都合で、このリポジトリの
 * server 側コード（`client-detail-page.tsx` 自体や `../csrf` 経由で
 * `composition/container.ts` まで）を import できない——import すると
 * `Env` / `Fetcher` / `D1Database` が解決できず型検査が落ちる（最初の
 * 実装でこれを踏んだ）。そのため、あちらは埋め込んだ class 文字列を見る
 * だけで、**この 2 画面が実際にその class 文字列を使っているか**までは
 * 検査できていない。ここ（workerd 側、`tsconfig.json` 本体）でその穴を
 * 埋める。
 *
 * `aria-selected` は `attachTabs`（client 側の JS）が実行時に付けるもので、
 * サーバーが返す HTML には最初から載っていない——ここで見るのは
 * **強調用の class が静的な markup に含まれているか**だけで、
 * `aria-selected="true"` の有無そのものは見ない（DOM が無いので見られない）。
 */
describe("選択中タブの強調が実在する画面に乗っている（指摘: 3b）", () => {
  const TARGET_CLIENT_ID = "app_tab_highlight_target";
  const TARGET_CARD_ID = "nfc_tab_highlight_target";

  function overrides() {
    return {
      nfcCards: {
        ...minimalNfcCards(),
        getCard: async () =>
          rpcOk({
            cardId: TARGET_CARD_ID,
            status: "active" as const,
            ownerUserId: null,
            targetUrl: "https://go.under18.dev/c/nfc_tab_highlight_target",
            batch: null,
            issuedAt: "2026-01-01T00:00:00.000Z",
            claimedAt: null,
            transferCount: 0,
            disabledAt: null,
            disabledReason: null,
            tapCount: 0,
            lastTappedAt: null,
          }),
        // `.catch()` で畳まれる経路を通す（`nfc.routes.tsx` のコメント参照）。
        // `tapHistory: null` で描ければこのテストには十分。
        cardTapHistory: async () => {
          throw new Error("tab-highlight.test.ts: cardTapHistory は使わない");
        },
      },
      identityAdmin: {
        ...minimalIdentityAdmin(),
        getOAuthClient: async () =>
          rpcOk({
            clientId: TARGET_CLIENT_ID,
            name: "Tab Highlight Target Client",
            clientType: "public" as const,
            isFirstParty: false,
            logoUrl: null,
            redirectUris: ["https://example.test/callback"],
            scopes: ["openid"],
            createdAt: "2026-01-01T00:00:00.000Z",
            disabledAt: null,
            ownerUserId: null,
            appUrl: null,
          }),
      },
    };
  }

  /** 強調に使っている 2 つの Tailwind variant utility（指摘: 3b）。 */
  const HIGHLIGHT_MARKERS = ["aria-selected:border-primary", "aria-selected:text-foreground"];

  const CASES: ReadonlyArray<{ readonly name: string; readonly path: string }> = [
    { name: "client-detail-page.tsx", path: `/clients/${TARGET_CLIENT_ID}` },
    { name: "card-detail-page.tsx", path: `/nfc/${TARGET_CARD_ID}` },
  ];

  it.each(CASES)("$name: data-tab の button が強調用の class を持つ", async ({ path }) => {
    const sub = "usr_tab_highlight_viewer";
    const approvals = fakeApprovals([sub]);
    const cookie = await loginAs(sub, approvals, overrides());

    const response = await createApp({ ...overrides(), approvals }).fetch(
      new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } }),
      env,
      executionContext(),
    );
    expect(response.status, `${path} が 200 を返さない`).toBe(200);

    const html = await response.text();
    const buttons = html.match(/<button[^>]*data-tab="[^"]*"[^>]*>/g) ?? [];
    expect(buttons.length, `${path} に data-tab の button が無い`).toBeGreaterThan(0);

    for (const button of buttons) {
      for (const marker of HIGHLIGHT_MARKERS) {
        expect(button, `${path} の ${button} に ${marker} が無い`).toContain(marker);
      }
    }
  });
});
