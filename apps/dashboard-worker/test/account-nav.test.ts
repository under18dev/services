import { ACCOUNT_NAV_GROUPS, accountNavFor } from "@u18/contracts";
import type { AccountNavGroup } from "@u18/contracts";
import { describe, expect, it } from "vitest";

/**
 * サイドバーの出し分け（#333）。
 *
 * ## なぜ dashboard-worker の test に居るのか
 *
 * **`@u18/contracts` に vitest が無い。** 足すこともできるが、この関数の
 * 消費者は dashboard-worker と nfc-worker の 2 つで、**どちらも
 * サイドバーを描く側**である。describe の中身は純粋な関数の検査なので、
 * どちらか一方の test に置けば足りる。
 *
 * **`@u18/web-ui` には置けない。** あちらは contracts に依存しない
 * （`account-nav.ts` の冒頭 ——「UI の部品がデプロイの構成を抱える」）。
 *
 * ## 本物の並びで試さない
 *
 * **いま `adminOnly` の項目は 1 つも無い。** 本物で試すと
 * `accountNavFor(true)` と `accountNavFor(false)` が同じものを返すので、
 * **何を壊しても緑になる。** 作り物の並びで、フィルタそのものを見る。
 */

const FIXTURE: readonly AccountNavGroup[] = [
  {
    label: "みんなに出る",
    items: [{ key: "profile", href: "/account/profile", label: "プロフィール" }],
  },
  {
    label: "混在",
    items: [
      { key: "apps", href: "/account/apps", label: "アプリ" },
      { key: "nfc", href: "/account/nfc", label: "NFC", adminOnly: true },
    ],
  },
  {
    label: "管理だけ",
    items: [{ key: "grants", href: "/account/grants", label: "連携", adminOnly: true }],
  },
];

/** テスト用の並びで `accountNavFor` と同じ畳み方をする。 */
function filtered(
  isAdmin: boolean,
  groups: readonly AccountNavGroup[],
): readonly AccountNavGroup[] {
  if (isAdmin) return groups;
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => i.adminOnly !== true) }))
    .filter((g) => g.items.length > 0);
}

describe("管理者にだけ出す項目", () => {
  it("非管理者からは adminOnly の項目が消える", () => {
    const groups = filtered(false, FIXTURE);
    const keys = groups.flatMap((g) => g.items.map((i) => i.key));

    expect(keys).toEqual(["profile", "apps"]);
  });

  it("adminOnly だけのグループは、見出しごと消える", () => {
    // **見出しが残ると、隠した意味が無くなる** —— 非管理者に
    // 「ここに何かある」が見える。
    expect(filtered(false, FIXTURE).map((g) => g.label)).toEqual(["みんなに出る", "混在"]);
  });

  it("管理者には何も落とさない", () => {
    expect(filtered(true, FIXTURE)).toEqual(FIXTURE);
  });

  it("本物の並びも、同じ畳み方で同じ結果になる", () => {
    // **フィルタの実装が 2 つに分かれていないことを見る。** 上の 3 本は
    // 作り物で振る舞いを固定し、ここが本物と繋いでいる。
    expect(accountNavFor(false)).toEqual(filtered(false, ACCOUNT_NAV_GROUPS));
    expect(accountNavFor(true)).toEqual(ACCOUNT_NAV_GROUPS);
  });

  it("本物の並びの adminOnly は、画面がある項目だけである", () => {
    // **かつてここは「本物に adminOnly が 1 つも無い」を見ていた。**
    // 0 件のあいだは出し分けが「何を壊しても緑」なので、最初の 1 件が
    // 入ったら**画面を引いて確かめる検査へ置き換えること**が
    // 書いてあった。置き換え先は `admin-clients.test.ts` の
    // 「サイドバーの管理の節」で、**実際に HTML を引いて**管理者には
    // 出る / 出ないを見ている。
    //
    // ここに残すのは、**行き先が `/account/` の下にあること**だけ。
    // 外のパスを `adminOnly` で足すと、`check-app-catalog-routes.mjs` が
    // 解決する先が変わる。
    const adminItems = ACCOUNT_NAV_GROUPS.flatMap((g) => g.items.filter((i) => i.adminOnly));

    expect(adminItems.length).toBeGreaterThan(0);
    for (const item of adminItems) expect(item.href.startsWith("/account/")).toBe(true);
  });
});
