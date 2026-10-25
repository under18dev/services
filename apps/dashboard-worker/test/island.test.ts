import { DEV_SESSION_COOKIE_NAME, rpcOk } from "@u18/contracts";
import type { GrantListItem, SessionListItem } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE_PATH, createApp } from "../src/presentation/http/app";
import { ACCOUNT_ISLAND_PATH, ACCOUNT_ISLAND_ROUTE } from "../src/presentation/http/ui/asset-paths";
import { ORIGIN, envWith, executionContext } from "./helpers";

/**
 * クライアントアイランド（失効・解除の操作）。
 *
 * ここで確かめられるのは**サーバー側が用意しているもの**だけ。
 * ブラウザでの挙動（クリックして消える）はここでは動かせないので、
 * アイランドが動くために必要な 3 つを見る:
 *
 *  1. バンドルが配信されていること
 *  2. 画面が `<script>` でそれを読み込んでいること
 *  3. 操作対象が `data-revoke-*` で特定できること
 *
 * **1 と 2 がずれると「ボタンが黙って現れない」。** 画面は正常に描画
 * されるので見た目では気づけない（`asset-paths.ts` の JSDoc と同じ話）。
 */

const SESSION: SessionListItem = {
  sessionId: "ses_1",
  createdAt: "2026-10-24T00:00:00.000Z",
  lastSeenAt: "2026-10-25T00:00:00.000Z",
  expiresAt: "2026-10-25T12:00:00.000Z",
  current: true,
  userAgent: "Mozilla/5.0 (Macintosh) Chrome/140",
};

const GRANT: GrantListItem = {
  clientId: "client-abc",
  clientName: "サンプルアプリ",
  logoUrl: null,
  scopes: ["openid", "profile"],
  grantedAt: "2026-10-24T00:00:00.000Z",
};

async function get(path: string, identity: object): Promise<Response> {
  return await createApp().fetch(
    new Request(`${ORIGIN}${ACCOUNT_BASE_PATH}${path}`, {
      headers: { Cookie: `${DEV_SESSION_COOKIE_NAME}=token-value` },
    }),
    envWith(identity),
    executionContext(),
  );
}

describe("バンドルの配信", () => {
  it("JavaScript として返る", async () => {
    const response = await get(ACCOUNT_ISLAND_ROUTE, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/javascript");
    expect((await response.text()).length).toBeGreaterThan(0);
  });

  it("キャッシュを許す（全利用者に同じで、個人情報を含まない）", async () => {
    const response = await get(ACCOUNT_ISLAND_ROUTE, {});
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("Cookie を付けても応答が変わらない", async () => {
    // 個人情報を含まないことを、説明ではなく振る舞いで確かめる
    // （スタイルシートと同じ扱い）。
    const withCookie = await (await get(ACCOUNT_ISLAND_ROUTE, {})).text();
    const without = await (
      await createApp().fetch(
        new Request(`${ORIGIN}${ACCOUNT_BASE_PATH}${ACCOUNT_ISLAND_ROUTE}`),
        envWith({}),
        executionContext(),
      )
    ).text();
    expect(withCookie).toBe(without);
  });
});

describe("画面がアイランドを読み込む", () => {
  it.each([
    ["/sessions", { listSessions: async () => rpcOk([SESSION]) }],
    ["/grants", { listGrants: async () => rpcOk([GRANT]) }],
  ])("%s が script で読み込む", async (path, identity) => {
    const html = await (await get(path, identity)).text();
    // **接頭辞つきのパス**で読む。`asset-paths.ts` が `*_ROUTE` から
    // 導出しているので、片方だけ変えることは型の上でできない。
    expect(html).toContain(`src="${ACCOUNT_ISLAND_PATH}"`);
  });

  it("サーバーはボタンを出さない（JS 無しで押せるのに効かない、にしない）", async () => {
    const html = await (
      await get("/sessions", { listSessions: async () => rpcOk([SESSION]) })
    ).text();
    expect(html).not.toContain("<button");
  });
});

describe("操作対象を特定できる", () => {
  it("セッションに id と種別が載る", async () => {
    const html = await (
      await get("/sessions", { listSessions: async () => rpcOk([SESSION]) })
    ).text();
    expect(html).toContain('data-revoke-kind="session"');
    expect(html).toContain(`data-revoke-id="${SESSION.sessionId}"`);
  });

  it("連携アプリに clientId と種別が載る", async () => {
    const html = await (await get("/grants", { listGrants: async () => rpcOk([GRANT]) })).text();
    expect(html).toContain('data-revoke-kind="grant"');
    expect(html).toContain(`data-revoke-id="${GRANT.clientId}"`);
  });

  it("見出しは属性で二重に載せない（島が DOM から読む）", async () => {
    // 属性で渡すと、要約できない User-Agent のときに同じ文字列が
    // 2 回 HTML に載る（`ui-pages.test.ts` が禁じている）。
    const html = await (await get("/grants", { listGrants: async () => rpcOk([GRANT]) })).text();
    expect(html).not.toContain("data-revoke-label");
  });
});
