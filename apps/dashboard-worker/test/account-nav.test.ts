import { ACCOUNT_NAV_GROUPS } from "@u18/contracts";
import { describe, expect, it } from "vitest";

/**
 * サイドバーの並び（#333 / #433）。
 *
 * ## なぜ dashboard-worker の test に居るのか
 *
 * **`@u18/contracts` に vitest が無い。** 足すこともできるが、この並びの
 * 消費者は dashboard-worker と nfc-worker の 2 つで、**どちらも
 * サイドバーを描く側**である。describe の中身は純粋な値の検査なので、
 * どちらか一方の test に置けば足りる。
 *
 * **`@u18/web-ui` には置けない。** あちらは contracts に依存しない
 * （`account-nav.ts` の冒頭 ——「UI の部品がデプロイの構成を抱える」）。
 *
 * ## かつてここは出し分けを見ていた
 *
 * `accountNavFor(isAdmin)` が `adminOnly` の項目を畳む関数で、作り物の
 * 並びを使ってその畳み方を固定していた。**#433 で運営向けの項目を
 * `admin.under18.dev` へ移し、畳むものが 1 つも無くなった**ので、関数ごと
 * 消した（理由は `account-nav.ts`）。
 *
 * **代わりに「戻ってきていないこと」を見る。** 消したものの検査は、
 * 消えたままであることを言えないと意味が無い —— 誰かが `/account/*` へ
 * 管理の画面を足し直すと、**入口が 2 つに戻る。**
 */

/** 並びに出てくる項目を平らにする。 */
const items = ACCOUNT_NAV_GROUPS.flatMap((group) => group.items);

describe("account のサイドバー", () => {
  it("行き先はすべて /account/ の下にある", () => {
    // 外のパスを足すと `check-app-catalog-routes.mjs` が解決する先が
    // 変わる（あちらは本番 route で勝つ Worker まで見ている）。
    for (const item of items) expect(item.href.startsWith("/account/")).toBe(true);
  });

  it("運営向けの項目が 1 つも無い（#433）", () => {
    // **`admin.under18.dev` へ移したもの。** ここへ戻すと、利用者向けの
    // 画面と運営向けの画面が同じサイドバーに並び、**移した先と移す前の
    // 2 つの入口**ができる。admin 側の並びは admin-worker の
    // `ui/nav.ts`（`ADMIN_NAV_GROUPS`）にある。
    const moved = [
      "/account/admin/users",
      "/account/admin/clients",
      "/account/admin/audit",
      "/account/nfc/admin",
    ];
    const hrefs = items.map((item) => item.href);

    for (const href of moved) expect(hrefs).not.toContain(href);
  });

  it("「管理」という見出しの節が無い（#433）", () => {
    // 節ごと消したので、見出しだけが残る形にもならない。
    expect(ACCOUNT_NAV_GROUPS.map((group) => group.label)).not.toContain("管理");
  });

  it("並びの順序を固定する", () => {
    // **件数や更新日で並べ替えない**（`account-nav.ts`）。前に見た位置を
    // 覚えている人が毎回探し直すことになる。
    expect(items.map((item) => item.key)).toEqual([
      "profile",
      "passkeys",
      "sessions",
      "grants",
      "apps",
      "nfc",
    ]);
  });
});
