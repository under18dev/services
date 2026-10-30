import { DEV_SESSION_COOKIE_NAME, rpcOk } from "@u18/contracts";
import { collectAssetRefs, normalizeAssetHash } from "@u18/web-ui";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import {
  ASSET_ROUTES,
  EXTERNALLY_UNVERIFIABLE_ASSETS,
  HTML_PAGE_ROUTES,
  PROBE_PAGES,
} from "./route-inventory";
import { ORIGIN, envWith, executionContext } from "./helpers";

/**
 * アセット → ページの向き（#313）。
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
 * つまり「参照されなくなったアセット」は、どちらからも見えなかった。
 *
 * ## 実際に起きたこと
 *
 * #316 で画面を 5 枚に割ったとき、**`/account`（ホーム）がアイランドを
 * 読まなくなった。** 本番検査が引くのは `/account` だけだったので、
 * `account-island.<hash>.js` は**本番で 1 回も確かめられない**状態になった。
 * **検査は緑のまま通る** —— CSS は拾うので、出力は何も変わらない。
 *
 * ## なぜここに置くのか
 *
 * **参照の有無はレンダリングしないと分からない。** 静的にファイルを読む
 * `check-asset-probe-pages.mjs` には見られない対応である。
 */

const PROFILE = {
  id: "usr_test",
  username: "taro",
  displayName: "Taro",
  email: "taro@example.com",
  emailVerified: true,
  status: "active" as const,
  isAdmin: false,
  createdAt: "2026-10-24T00:00:00.000Z",
};

const IDENTITY = {
  getUserProfile: async () => rpcOk(PROFILE),
  listPasskeys: async () => rpcOk([]),
  listSessions: async () => rpcOk([]),
  listGrants: async () => rpcOk([]),
  getSession: async () => rpcOk(null),
};

/**
 * 管理画面も 200 で引けるようにする（#333）。
 *
 * **このファイルは「参照されていないアセット」を探すのが目的**なので、
 * 中身は空でよい。**ただし 200 である必要がある** —— 503 だと参照が
 * 読めず、「アセットを 1 つも参照していない画面」と区別が付かない。
 */
const IDENTITY_ADMIN = {
  listOAuthClients: async () => rpcOk([]),
  listUsers: async () => rpcOk({ users: [], nextCursor: null }),
};

/** 未認証で引いたときの参照。**本番のアセット検査が見るのはこちら。** */
async function refsWithoutSession(path: string): Promise<readonly string[]> {
  const response = await createApp().fetch(
    new Request(`${ORIGIN}${path}`),
    envWith(IDENTITY as never, undefined, IDENTITY_ADMIN as never),
    executionContext(),
  );
  // 401 でも画面は返る（ログイン導線）。本文が読めることだけ確かめる。
  expect([200, 401], `${path} が想定外の ${response.status}`).toContain(response.status);
  return collectAssetRefs(await response.text());
}

async function refsOf(path: string): Promise<readonly string[]> {
  const response = await createApp().fetch(
    new Request(`${ORIGIN}${path}`, {
      headers: { Cookie: `${DEV_SESSION_COOKIE_NAME}=token-value` },
    }),
    envWith(IDENTITY as never, undefined, IDENTITY_ADMIN as never),
    executionContext(),
  );
  // 200 でなければ参照が読めない。**0 件と区別が付かない**ので先に落とす。
  expect(response.status, `${path} が 200 を返さない`).toBe(200);
  return collectAssetRefs(await response.text());
}

const EXPECTED_ASSETS = ASSET_ROUTES.map((route) => normalizeAssetHash(route.path)).sort();

describe("アセットはどこかのページから参照されている", () => {
  it("一覧にあるアセットが 1 つ以上ある", () => {
    // 0 件だと下のテストが**何も確かめずに通る。**
    expect(EXPECTED_ASSETS.length).toBeGreaterThan(0);
  });

  it("全画面を合わせると、一覧のアセットを全部覆う", async () => {
    const seen = new Set<string>();
    for (const route of HTML_PAGE_ROUTES) {
      for (const ref of await refsOf(route.path)) seen.add(ref);
    }

    // 誰も参照しないアセットは、配信ルートだけが残った状態である。
    // 消し忘れか、参照を外したかのどちらか。
    expect([...seen].sort()).toEqual(expect.arrayContaining(EXPECTED_ASSETS));
  });
});

describe("本番検査が外から確かめられる範囲", () => {
  it("PROBE_PAGES が空でなく、実在するページである", () => {
    expect(PROBE_PAGES.length).toBeGreaterThan(0);
    const pages = HTML_PAGE_ROUTES.map((route) => route.path);
    for (const page of PROBE_PAGES) {
      expect(pages, `${page} は HTML_PAGE_ROUTES に無い`).toContain(page);
    }
  });

  it("外から確かめられないアセットには理由が書いてある", () => {
    for (const [asset, reason] of Object.entries(EXTERNALLY_UNVERIFIABLE_ASSETS)) {
      expect(EXPECTED_ASSETS, `${asset} は一覧に無い`).toContain(asset);
      // 空で通すと「確かめられない」が「確かめなくてよい」にすり替わる。
      expect(reason.trim().length, `${asset}: 理由が短すぎる`).toBeGreaterThan(20);
    }
  });

  it("PROBE_PAGES を未認証で引くと、宣言した範囲ちょうどが見える", async () => {
    // **ここが #313 の本体。** 本番のアセット検査は未認証でページを引くので、
    // 見えるのは「未認証のレンダリングが参照するもの」だけである。
    //
    // 一致で見る（包含ではない）。**多くても少なくても落とす:**
    //  - 少ない -> 外れたアセットが黙って検査の視界から消えている
    //  - 多い   -> 外から見えるようになったのに「確かめられない」と
    //              宣言したままになっている
    const seen = new Set<string>();
    for (const page of PROBE_PAGES) {
      for (const ref of await refsWithoutSession(page)) seen.add(ref);
    }

    const declaredUnverifiable = Object.keys(EXTERNALLY_UNVERIFIABLE_ASSETS);
    const expectedVisible = EXPECTED_ASSETS.filter(
      (asset) => !declaredUnverifiable.includes(asset),
    );

    expect(
      [...seen].sort(),
      `PROBE_PAGES（${PROBE_PAGES.join(" ")}）を未認証で引いたときに見えるアセットが、` +
        `EXTERNALLY_UNVERIFIABLE_ASSETS の宣言と噛み合っていません。`,
    ).toEqual(expectedVisible);
  });
});
