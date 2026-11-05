import { describe, expect, it } from "vitest";
import {
  attachCopyButton,
  attachFilter,
  attachNoticeToast,
  attachSortableTable,
  attachTabs,
  attachTooltips,
  rowsOf,
  sortValueOf,
} from "./admin-island";

/**
 * `admin-island.ts` の DOM 挙動（#470）。
 *
 * **ここだけが `document` を要求する。** 他のテスト（`test/**`）は
 * workerd（`@cloudflare/vitest-plugin`）の中で動くので `document` が無い
 * ——`vitest.client.config.ts` が `environment: "happy-dom"` で別枠にして
 * あり、`package.json` の `test` から両方呼ぶ。
 *
 * ## タブを厚めに見ている理由
 *
 * この issue の 3 画面（/audit /clients /nfc/analytics）はどれもタブを
 * 使わない——#454 の解析 6 区画は縦一列のままにする、という明示の判断の
 * ため。それでも `data-tabs` は #471〜#473 への契約として渡すので、**誰も
 * 動かさないコードのまま main へ入れない**（指摘: 3b）。
 */

describe("attachSortableTable", () => {
  function buildTable(): HTMLTableElement {
    document.body.innerHTML = `
      <table data-sortable>
        <thead><tr>
          <th data-sort="number">件数</th>
          <th data-sort="text">名前</th>
        </tr></thead>
        <tbody>
          <tr><td>3</td><td>banana</td></tr>
          <tr><td>1</td><td>apple</td></tr>
          <tr><td>2</td><td>cherry</td></tr>
        </tbody>
      </table>
    `;
    return document.querySelector("table")!;
  }

  it("クリックで昇順に並び替わる", () => {
    const table = buildTable();
    attachSortableTable(table);
    const button = table.querySelector<HTMLButtonElement>("thead th:first-child button")!;
    button.click();

    const firstCells = Array.from(table.querySelectorAll("tbody tr")).map(
      (row) => row.children[0]?.textContent,
    );
    expect(firstCells).toEqual(["1", "2", "3"]);
  });

  it("もう一度押すと降順になる", () => {
    const table = buildTable();
    attachSortableTable(table);
    const button = table.querySelector<HTMLButtonElement>("thead th:first-child button")!;
    button.click();
    button.click();

    const firstCells = Array.from(table.querySelectorAll("tbody tr")).map(
      (row) => row.children[0]?.textContent,
    );
    expect(firstCells).toEqual(["3", "2", "1"]);
  });

  it("日付でないテキストを number として読んでも落ちない", () => {
    expect(sortValueOf(undefined, "number")).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("attachFilter", () => {
  it("table の tbody > tr を絞り込む", () => {
    document.body.innerHTML = `
      <input data-filter="t1" hidden />
      <table id="t1"><tbody>
        <tr><td>apple</td></tr>
        <tr><td>banana</td></tr>
      </tbody></table>
    `;
    const input = document.querySelector<HTMLInputElement>("input[data-filter]")!;
    attachFilter(input);
    expect(input.hidden).toBe(false);

    input.value = "ban";
    input.dispatchEvent(new Event("input"));

    const rows = Array.from(document.querySelectorAll<HTMLElement>("tbody > tr"));
    expect(rows.map((r) => r.hidden)).toEqual([true, false]);
  });

  it("ul の直接の li も絞り込める（テーブル限定にしない）", () => {
    document.body.innerHTML = `
      <input data-filter="list1" hidden />
      <ul id="list1">
        <li>foo</li>
        <li>bar</li>
      </ul>
    `;
    const input = document.querySelector<HTMLInputElement>("input[data-filter]")!;
    attachFilter(input);

    input.value = "bar";
    input.dispatchEvent(new Event("input"));

    const items = Array.from(document.querySelectorAll<HTMLElement>("li"));
    expect(items.map((r) => r.hidden)).toEqual([true, false]);
  });

  it("件数が嘘にならない——絞り込み中は表示件数を出す", () => {
    document.body.innerHTML = `
      <input data-filter="t1" hidden />
      <table id="t1"><tbody>
        <tr><td>apple</td></tr>
        <tr><td>banana</td></tr>
        <tr><td>cherry</td></tr>
      </tbody></table>
    `;
    const input = document.querySelector<HTMLInputElement>("input[data-filter]")!;
    attachFilter(input);

    input.value = "an";
    input.dispatchEvent(new Event("input"));

    const count = input.nextElementSibling;
    expect(count?.textContent).toBe("1 / 3 件（この一覧から絞り込み）");
  });

  it("rowsOf は対象が無くても空配列を返す", () => {
    document.body.innerHTML = `<ul id="empty"></ul>`;
    expect(rowsOf(document.getElementById("empty")!)).toEqual([]);
  });
});

describe("attachCopyButton", () => {
  it("クリックで clipboard.writeText を呼ぶ", async () => {
    document.body.innerHTML = `<button data-copy="usr_abc123" hidden>コピー</button>`;
    const button = document.querySelector<HTMLButtonElement>("button[data-copy]")!;

    const writeText = async (_text: string) => undefined;
    // **`navigator.clipboard` は getter 専用。** happy-dom では
    // `Object.assign` で直接代入できない（実測）。
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    attachCopyButton(button);
    expect(button.hidden).toBe(false);

    button.click();
    // writeText は非同期。マイクロタスクが片付くのを待つ。
    await Promise.resolve();
    await Promise.resolve();
    expect(button.textContent).toBe("コピーしました");
  });
});

describe("attachTabs", () => {
  function buildTabs(): HTMLElement {
    document.body.innerHTML = `
      <div data-tabs>
        <button data-tab="a">A</button>
        <button data-tab="b">B</button>
        <section data-panel="a">panel A</section>
        <section data-panel="b">panel B</section>
      </div>
    `;
    return document.querySelector<HTMLElement>("[data-tabs]")!;
  }

  it("既定で 1 枚目だけが見える", () => {
    const root = buildTabs();
    attachTabs(root);

    expect(root.querySelector('[data-panel="a"]')).toHaveProperty("hidden", false);
    expect(root.querySelector('[data-panel="b"]')).toHaveProperty("hidden", true);
  });

  it("クリックで切り替わる", () => {
    const root = buildTabs();
    attachTabs(root);

    root.querySelector<HTMLButtonElement>('[data-tab="b"]')!.click();

    expect(root.querySelector('[data-panel="a"]')).toHaveProperty("hidden", true);
    expect(root.querySelector('[data-panel="b"]')).toHaveProperty("hidden", false);
  });

  it("data-panel が無い data-tab を押しても落ちない", () => {
    document.body.innerHTML = `
      <div data-tabs>
        <button data-tab="orphan">迷子</button>
        <section data-panel="a">panel A</section>
      </div>
    `;
    const root = document.querySelector<HTMLElement>("[data-tabs]")!;
    expect(() => attachTabs(root)).not.toThrow();

    const button = root.querySelector<HTMLButtonElement>('[data-tab="orphan"]')!;
    expect(() => button.click()).not.toThrow();
  });

  it("data-tabs が無ければ何もしない（JS 無しと同じ形を壊さない）", () => {
    document.body.innerHTML = `<div><section data-panel="a">panel A</section></div>`;
    const root = document.querySelector<HTMLElement>("div")!;
    attachTabs(root);
    expect(root.querySelector('[data-panel="a"]')).toHaveProperty("hidden", false);
  });
});

describe("attachTooltips", () => {
  it("mouseenter で吹き出しを出し、mouseleave で隠す", () => {
    document.body.innerHTML = `<svg><rect data-tip="2026-11-01 · 12 タップ"></rect></svg>`;
    const target = document.querySelector<HTMLElement>("[data-tip]")!;
    attachTooltips([target]);

    target.dispatchEvent(new Event("mouseenter"));
    const tip = document.body.lastElementChild as HTMLElement;
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toBe("2026-11-01 · 12 タップ");

    target.dispatchEvent(new Event("mouseleave"));
    expect(tip.hidden).toBe(true);
  });

  it("対象が無ければ何もしない", () => {
    document.body.innerHTML = "";
    expect(() => attachTooltips([])).not.toThrow();
    expect(document.body.children.length).toBe(0);
  });
});

describe("attachNoticeToast", () => {
  it("要素自体は消さずにトーストを足す", () => {
    document.body.innerHTML = `<p data-notice>保存しました。</p>`;
    const el = document.querySelector<HTMLElement>("[data-notice]")!;
    attachNoticeToast(el);

    // 元の要素は残っている。
    expect(document.querySelector("[data-notice]")?.textContent).toBe("保存しました。");
    // トーストが足される。
    const toast = document.querySelector('[role="status"]');
    expect(toast?.textContent).toBe("保存しました。");
  });

  it("空文字では何も足さない", () => {
    document.body.innerHTML = `<p data-notice></p>`;
    const el = document.querySelector<HTMLElement>("[data-notice]")!;
    attachNoticeToast(el);
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});
