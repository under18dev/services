import { normalizeAssetHash } from "@u18/web-ui";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { env } from "cloudflare:test";
import {
  CARD_API_ROUTES,
  CARD_ASSET_ROUTES,
  CARD_CLAIM_ROUTES,
  CARD_PAGE_ROUTES,
  CARD_ROUTES,
  EXPECTED_ROUTES,
  HEALTH_ROUTES,
  REDIRECT_ROUTES,
} from "./route-inventory";
import { ORIGIN, executionContext, identityWith } from "./helpers";
import { KIWA_STYLESHEET_PATH } from "../src/presentation/http/ui/asset-paths";

/**
 * 登録されているルートが `route-inventory.ts` の一覧と一致すること（#275）。
 *
 * **この Worker は 2 つのホストに載っている。** `go.under18.dev/*` が全パスを
 * 拾うので、ここに並ぶ全部が短縮 URL のホストからも叩ける（#280）。
 * **「足したルートは `go.under18.dev` からも叩けてよいか」**を考える場所が
 * この一覧である。
 */
describe("公開面の一覧", () => {
  /** アセットの URL には内容ハッシュが入る（#211）。16 進 16 文字を伏せる。 */

  const actual = [
    ...new Set(
      createApp()
        .routes.filter((route) => route.method !== "ALL")
        .map((route) => `${route.method} ${normalizeAssetHash(route.path)}`),
    ),
  ];

  const expected = EXPECTED_ROUTES.map((route) => `${route.method} ${route.path}`);

  it("一覧に無いルートが登録されていない", () => {
    expect(actual.filter((route) => !expected.includes(route))).toEqual([]);
  });

  it("一覧にあるルートがすべて登録されている", () => {
    expect(expected.filter((route) => !actual.includes(route))).toEqual([]);
  });

  it("区分が重なっていない", () => {
    const all = [...REDIRECT_ROUTES, ...HEALTH_ROUTES, ...CARD_ROUTES].map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(all.length).toBe(new Set(all).size);
  });

  it("どの区分も空でない", () => {
    // **空の配列は `filter` しても `every` しても緑になる。** 0 件ガード。
    for (const [name, routes] of [
      ["REDIRECT_ROUTES", REDIRECT_ROUTES],
      ["HEALTH_ROUTES", HEALTH_ROUTES],
      ["CARD_API_ROUTES", CARD_API_ROUTES],
      ["CARD_PAGE_ROUTES", CARD_PAGE_ROUTES],
      ["CARD_ASSET_ROUTES", CARD_ASSET_ROUTES],
      ["CARD_CLAIM_ROUTES", CARD_CLAIM_ROUTES],
    ] as const) {
      expect(routes.length, `${name} が空`).toBeGreaterThan(0);
    }
  });
});

/**
 * **区分を「表」から「検査」にする**（#284 と同じ形）。
 *
 * 一覧と実際のルートが一致することは上で見ているが、**区分は手で書く**
 * ので、取り違えて載せても緑のままだった。実際この一覧は、
 * **公開アセット（CSS）とログインへ送る画面を「セッションが要る」側に
 * 入れていた。** 開いているものが閉じていることになっていた。
 *
 * ここで実際に叩いて、区分が主張するとおりの応答が返ることを見る。
 */
describe("区分どおりの応答が返る", () => {
  /**
   * Cookie 無しで叩く。
   *
   * **`:cardId` は `CARD_ID_PATTERN`（`/^[a-z0-9_]{1,64}$/`）に合う形で
   * 埋める。** ハイフンを含む値だと入口の形式検査で 404 になり、
   * **認証まで届かないものを「認証で止まった」と読み違える。**
   */
  /**
   * **本文は形式検査を通る値にする。**
   *
   * 空の `{}` で叩くと 3 本が 400 を返す —— `POST /cards`・`claim`・
   * `PUT /target` は**本文の検査が認証より先**にあるためである。漏れては
   * いない（400 はカードについて何も言わない）が、**それだと「認証が
   * 塞いでいる」ことを確かめたことにならない。** 形式を通したうえで
   * 401 が返ることを見る。
   */
  const BODIES: Record<string, unknown> = {
    "POST /account/nfc/cards": { count: 1 },
    "POST /account/nfc/cards/claim": { cardId: "doesnotexist" },
    "PUT /account/nfc/cards/:cardId/target": { targetUrl: "https://example.com/" },
  };

  async function callAnonymously(method: string, path: string): Promise<Response> {
    const body = BODIES[`${method} ${path}`] ?? {};
    return await createApp({ identity: identityWith({}) }).fetch(
      new Request(`${ORIGIN}${path.replaceAll(/:[A-Za-z]+/g, "doesnotexist")}`, {
        method,
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      executionContext(),
    );
  }

  it.each(CARD_API_ROUTES.map((route) => [`${route.method} ${route.path}`, route] as const))(
    "%s は Cookie 無しで 401",
    async (_label, route) => {
      const response = await callAnonymously(route.method, route.path);
      expect(response.status).toBe(401);
    },
  );

  it.each(CARD_PAGE_ROUTES.map((route) => [`${route.method} ${route.path}`, route] as const))(
    "%s は Cookie 無しでログインへ送る（401 ではない）",
    async (_label, route) => {
      const response = await callAnonymously(route.method, route.path);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toContain("/login?return_to=");
    },
  );

  it("GET /account/nfc/claim は Cookie 無しでログインへ送る", async () => {
    // **カードを引く前にログインを要求している**ことの裏返し。先に引くと、
    // 未認証の相手にも「この ID は紐づけられる」が見える（#358）。
    const response = await callAnonymously("GET", "/account/nfc/claim");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/login?return_to=");
  });

  it("POST /account/nfc/claim は Cookie 無しで 400（CSRF が先に落とす）", async () => {
    // **401 ではない。** セッションを見る前にトークンを確かめているので、
    // ここが 401 に変わったら順序が入れ替わっている。
    const response = await callAnonymously("POST", "/account/nfc/claim");

    expect(response.status).toBe(400);
  });

  it("CARD_CLAIM_ROUTES の区分が、API と画面のどちらとも重なっていない", () => {
    const others = [...CARD_API_ROUTES, ...CARD_PAGE_ROUTES].map(
      (route) => `${route.method} ${route.path}`,
    );
    for (const route of CARD_CLAIM_ROUTES) {
      expect(others).not.toContain(`${route.method} ${route.path}`);
    }
  });

  it("CARD_ASSET_ROUTES は Cookie 無しで 200（公開アセット）", async () => {
    // **ハッシュ付きの実パスで叩く。** 一覧側は `<hash>` で伏せてあるので、
    // そのままでは当たらない。
    const response = await callAnonymously("GET", KIWA_STYLESHEET_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/css");
  });

  it("CARD_ASSET_ROUTES の一覧が実パスと対応している", () => {
    // 上の検査は `KIWA_STYLESHEET_PATH` を直接使うので、**一覧側が間違っていても
    // 200 になる。** 伏せ字に直した形が一覧と一致することを別途見る。
    const normalized = normalizeAssetHash(KIWA_STYLESHEET_PATH);
    expect(CARD_ASSET_ROUTES.map((route) => route.path)).toContain(normalized);
  });
});
