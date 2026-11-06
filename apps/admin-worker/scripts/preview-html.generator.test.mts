import { beforeAll, describe, expect, it } from "vitest";
// **`.mjs` 指定が要る。** 実体は `.mts` だが、`allowImportingTsExtensions`
// が false なので `.mts` のまま import できない。拡張子無しだと
// `moduleResolution: "Bundler"` が `.mts` の相手を見つけられなかった
// （実測）——`.js`/`.mjs` 宛ての import を実ソースへ読み替える仕組みは
// `.ts` → `.js` 宛てと同じ形で `.mts` → `.mjs` 宛てにも効く。
import { buildPreviewPages, type PreviewPage } from "./preview-html.generator.mjs";

/**
 * プレビュー出力の不変条件（#524）。
 *
 * **今日 3 回、プレビューの偽物・架空データが契約の意味から静かにずれた。**
 * 2 件（カードの架空データが 2 枚ともタップ 0 件でアナリティクスが空のまま、
 * `filterAuditLog` が `category` を無視して絞り込みが効かない）は、型検査
 * （#476）を通り抜ける——引数を無視しているだけ、または架空データが薄い
 * だけで、型はどちらも合っている。
 *
 * ここでは `buildPreviewPages()` が実際に返す HTML（`pnpm preview:html` が
 * 書き出すのと同じもの）に対して、「運用者がこの画面で見るはずのもの」を
 * 機械的に確かめる。**検査のために架空データを作り直さない**——
 * `preview-html.generator.mts` 側のコメントと合わせて読むこと。
 *
 * ## 条件 1: 0 件でも緑にしない
 *
 * 各検査は、対象を見つけられなかったこと自体を失敗として扱う
 * （`toContain` だけで済ませず、該当する要素の数を数えて `> 0` を assert
 * する——「0 個だったので `toContain` が最初から空振りして無意味に緑」を
 * 避けるため）。
 *
 * ## 条件 3 と両立する例（`nfc-card-detail-dormant`）
 *
 * 「タップ履歴のあるカードにはグラフが出る」だけを検査すると、架空データを
 * 「全カードにタップを持たせる」方向へ寄せたくなる——しかしそれは死蔵
 * （#472 の「死蔵の 1 枚ごとの顔」）という、運用者に見せたい別の状態を
 * 消してしまう。死蔵カードには**タップ 0 件の空状態が出ること**も検査し、
 * 架空データの多様性そのものを守る。
 */
let pagesByName: Map<string, PreviewPage>;

function pageHtml(name: string): string {
  const page = pagesByName.get(name);
  if (page === undefined) {
    throw new Error(`プレビューに "${name}" という画面が無い（名前が変わった？）`);
  }
  return page.html;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeAll(async () => {
  const pages = await buildPreviewPages();
  pagesByName = new Map(pages.map((p) => [p.name, p]));
}, 60_000);

describe("/nfc の一覧", () => {
  it("行が 1 行以上ある", () => {
    // 行だけが持つ目印（`data-select="nfc-cards"`）を数える。
    // ヘッダの全選択は `data-select-all="nfc-cards"` で別の属性名
    // ——同じ正規表現に紛れ込まない。
    const rowCount = countOccurrences(pageHtml("nfc"), 'data-select="nfc-cards"');
    expect(rowCount).toBeGreaterThan(0);
  });
});

describe("/users の一覧", () => {
  it("行が 1 行以上ある", () => {
    // `/users` は `/nfc` と違って一括操作を持たない（#489 で行内の操作を
    // 詳細ページへ寄せたあと、残っているのは名前から詳細への導線だけ）
    // ——行だけが持つ目印として、詳細への `href` を数える。
    const rowCount = countOccurrences(pageHtml("users"), 'href="/users/usr_preview');
    expect(rowCount).toBeGreaterThan(0);
  });
});

describe("カード詳細のタップ履歴グラフ（#512・#513）", () => {
  it("タップ履歴のあるカード（nfc-card-detail-busy）には、実際に <rect> のグラフが出る", () => {
    const html = pageHtml("nfc-card-detail-busy");
    const rectCount = countOccurrences(html, "<rect");
    expect(rectCount).toBeGreaterThan(0);
    // **これが #512/#513 で壊れていた形。** 以前はこの画面も含め、
    // 架空データのカードが 2 枚ともタップ 0 件で、常にこちら側の
    // 空状態の文言に差し替わっていた。
    expect(html).not.toContain("この期間はタップがありません。");
  });

  it("死蔵のカード（nfc-card-detail-dormant）は、タップ 0 件の空状態のままである", () => {
    // **上の検査と対になる、条件 3 の実例。** 「グラフを出す」側だけを
    // 検査すると、架空データを「全カードにタップを持たせる」方向へ
    // 寄せたくなる——死蔵（#472）という別の見せたい状態を検査で守る。
    const html = pageHtml("nfc-card-detail-dormant");
    expect(html).toContain("この期間はタップがありません。");
    expect(countOccurrences(html, "<rect")).toBe(0);
  });
});
