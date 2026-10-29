import { env } from "cloudflare:test";
import { collectAssetRefs, normalizeAssetHash } from "@u18/web-ui";
import { beforeEach, describe, expect, it } from "vitest";
import { CARDS_UI_PATH, createApp } from "../src/presentation/http/app";
import { CARD_ASSET_ROUTES, CARD_PAGE_ROUTES } from "./route-inventory";
import {
  ORIGIN,
  cookieFor,
  executionContext,
  identityWith,
  resetDatabase,
  seedActiveCard,
} from "./helpers";

/**
 * アセット → ページの向き（#313）。
 *
 * ## この Worker は外からの検査で閉じられない
 *
 * カード画面 `/account/nfc` は**未ログインで 302 を返す**ので、
 * `scripts/smoke-asset-probe.sh` はページに書いてある URL を読めない。
 * だから `UNPROBEABLE` に入っている（`scripts/lib/asset-probe-pages.mjs`）。
 *
 * **ここが代わりを務める。** テスト内ならセッションを作れるので、
 * **外からは閉じられなかった穴がこの向きだと閉じる。**
 *
 * #246 で踏んだのは、この Worker が auth-worker の CSS を借りていて、
 * **借り先のハッシュが変わった瞬間に画面がスタイルを失った**ことだった。
 * いまは自分で配っているが、**参照をやめれば同じ無言の壊れ方をする** ——
 * 画面は描かれるので 500 にもならない。
 */

const TARO = "token-taro-0123456789abcdefghijklmn";
const identity = identityWith({ [TARO]: "usr_taro" });

const EXPECTED_ASSETS = CARD_ASSET_ROUTES.map((route) => normalizeAssetHash(route.path)).sort();

beforeEach(resetDatabase);

describe("カード画面がアセットを参照している", () => {
  it("一覧にアセットがある", () => {
    // 0 件だと下のテストが**何も確かめずに通る。**
    expect(EXPECTED_ASSETS.length).toBeGreaterThan(0);
  });

  it("画面が 1 枚しか無いことを確かめる", () => {
    // 増えたらこのテストの前提（下で 1 枚だけ開く）が崩れる。
    expect(CARD_PAGE_ROUTES.map((route) => route.path)).toEqual([CARDS_UI_PATH]);
  });

  it("ログイン済みで開いた画面が、一覧のアセットを全部参照している", async () => {
    await seedActiveCard("usr_taro", "https://example.com/taro");

    const response = await createApp({ identity }).fetch(
      new Request(`${ORIGIN}${CARDS_UI_PATH}`, { headers: { Cookie: cookieFor(TARO) } }),
      env,
      executionContext(),
    );

    // 200 でなければ参照が読めない。**0 件と区別が付かない**ので先に落とす。
    expect(response.status, `${CARDS_UI_PATH} が 200 を返さない`).toBe(200);

    const seen = new Set(collectAssetRefs(await response.text()));
    const uncovered = EXPECTED_ASSETS.filter((asset) => !seen.has(asset));
    expect(
      uncovered,
      `カード画面がこのアセットを参照していません。配信ルートだけが残った状態です。`,
    ).toEqual([]);
  });
});
