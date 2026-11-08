import { describe, expect, it } from "vitest";
import {
  attachCopyButton,
  attachFilter,
  attachNoticeToast,
  attachSelection,
  attachSortableTable,
  attachTabs,
  attachTooltips,
  rowsOf,
  sortValueOf,
} from "./admin-island";

/**
 * `admin-island.ts` の DOM 挙動（#470、選択・一括操作は #481）。
 *
 * **ここだけが `document` を要求する。** 他のテスト（`test/**`）は
 * workerd（`@cloudflare/vitest-plugin`）の中で動くので `document` が無い
 * ——`vitest.client.config.ts` が `environment: "happy-dom"` で別枠にして
 * あり、`package.json` の `test` から両方呼ぶ。
 *
 * ## タブを厚めに見ている理由
 *
 * #470 の 3 画面（/audit /clients /nfc/analytics）はどれもタブを
 * 使わない——#454 の解析 6 区画は縦一列のままにする、という明示の判断の
 * ため。それでも `data-tabs` は #471〜#473 への契約として渡すので、**誰も
 * 動かさないコードのまま main へ入れない**（指摘: 3b）。
 *
 * ## 選択（`attachSelection`）と絞り込み（`attachFilter`）の連携も見る
 *
 * #481 で「絞り込みが隠した行の選択を外す」という依存が増えた。2 つの
 * 関数は互いを import していない（`attachFilter` は selection の存在を
 * 知らない、素の `change` イベントで繋がっている）ので、`attachFilter`
 * 側のテストに 1 本、`attachSelection` 側の起動テストにも別の 1 本を
 * 置いて、どちらが壊れても拾えるようにしてある。
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

  /**
   * `ui/format.ts` の `formatDateTime` が返す実際の形（「YYYY/MM/DD HH:MM
   * JST」）で並べ替えが効くこと。**末尾の「 JST」を `Date.parse` がそのまま
   * 読むと丸ごと `NaN` を返す**（実測、V8）——`/audit` を含む
   * `data-sort="date"` の列すべてが、#470 で足した時点からこのバグを
   * 持っていた（クリックしても順序が変わらないまま、誰も気づかずにいた）。
   * ユニットテストが `"2026-11-01"` のような ISO 文字列だけで書かれて
   * いて、本物の表示文字列を一度も通していなかったのが原因。
   */
  it("formatDateTime が出す「YYYY/MM/DD HH:MM JST」でも日付として並べ替わる", () => {
    document.body.innerHTML = `
      <table data-sortable>
        <thead><tr><th data-sort="date">日時</th></tr></thead>
        <tbody>
          <tr><td>2026/11/12 09:15 JST</td></tr>
          <tr><td>2026/11/05 20:03 JST</td></tr>
          <tr><td>2026/11/08 00:00 JST</td></tr>
        </tbody>
      </table>
    `;
    const table = document.querySelector<HTMLTableElement>("table")!;
    attachSortableTable(table);
    table.querySelector<HTMLButtonElement>("thead th button")!.click();

    const firstCells = Array.from(table.querySelectorAll("tbody tr")).map(
      (row) => row.children[0]?.textContent,
    );
    expect(firstCells).toEqual([
      "2026/11/05 20:03 JST",
      "2026/11/08 00:00 JST",
      "2026/11/12 09:15 JST",
    ]);
  });

  it("sortValueOf('date') は末尾の JST を落として読む", () => {
    const early = document.createElement("td");
    early.textContent = "2026/11/05 20:03 JST";
    const late = document.createElement("td");
    late.textContent = "2026/11/12 09:15 JST";

    const earlyValue = sortValueOf(early, "date");
    const lateValue = sortValueOf(late, "date");
    expect(earlyValue).not.toBe(Number.NEGATIVE_INFINITY);
    expect(earlyValue).toBeLessThan(lateValue as number);
  });

  /**
   * admin-worker には日時の書式が 2 つある——`formatDateTime`（上のテスト）
   * と `nfc-page.tsx` の `toDate()`（素の ISO 日付「YYYY-MM-DD」、時刻も
   * JST も付けない）。**後者が壊れていないことも合わせて見る**——`.replace()`
   * を足す前も後も、素の ISO 形式はタイムゾーン名が無いので何も削られず、
   * そのまま `Date.parse` に通る（指摘: 3b、#488）。
   */
  it("sortValueOf('date') は toDate() の素の ISO 日付（JST 無し）でも読める", () => {
    const early = document.createElement("td");
    early.textContent = "2026-07-31";
    const late = document.createElement("td");
    late.textContent = "2026-08-05";

    const earlyValue = sortValueOf(early, "date");
    const lateValue = sortValueOf(late, "date");
    expect(earlyValue).not.toBe(Number.NEGATIVE_INFINITY);
    expect(earlyValue).toBeLessThan(lateValue as number);
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

  it("絞り込みで隠れた行のチェックを外す（#481）——hidden は送信を止めないため", () => {
    document.body.innerHTML = `
      <input data-filter="t1" hidden />
      <table id="t1"><tbody>
        <tr><td>apple<input type="checkbox" data-select="g" checked /></td></tr>
        <tr><td>banana<input type="checkbox" data-select="g" checked /></td></tr>
      </tbody></table>
    `;
    const input = document.querySelector<HTMLInputElement>("input[data-filter]")!;
    attachFilter(input);

    input.value = "ban";
    input.dispatchEvent(new Event("input"));

    const checkboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
    );
    // apple の行は隠れた → チェックを外す。banana の行は見えている → 触らない。
    expect(checkboxes.map((c) => c.checked)).toEqual([false, true]);
  });
});

describe("attachSelection", () => {
  function buildTable(): void {
    document.body.innerHTML = `
      <input type="checkbox" data-select-all="cards" hidden />
      <output data-select-count="cards">選択したカードに対して操作します。</output>
      <table><tbody>
        <tr><td>a</td><td><input type="checkbox" data-select="cards" name="card_id" value="a" /></td></tr>
        <tr><td>b</td><td><input type="checkbox" data-select="cards" name="card_id" value="b" /></td></tr>
        <tr><td>c</td><td><input type="checkbox" data-select="cards" name="card_id" value="c" /></td></tr>
      </tbody></table>
    `;
  }

  it("起動直後にサーバーの静的な文言を件数つきへ差し替える（絶対条件: 空欄を残さない）", () => {
    buildTable();
    attachSelection("cards");
    expect(document.querySelector('[data-select-count="cards"]')?.textContent).toBe("0 件選択中");
  });

  it("チェックすると件数が増える（マイクロタスク 1 回を待つ）", async () => {
    buildTable();
    attachSelection("cards");
    const [a] = document.querySelectorAll<HTMLInputElement>('input[data-select="cards"]');
    a!.checked = true;
    a!.dispatchEvent(new Event("change"));
    // **`recount()` はマイクロタスクへまとめている**（500 行での実測、
    // #481 のレビュー）。同期で読むと更新前の値のままになる。
    await Promise.resolve();
    expect(document.querySelector('[data-select-count="cards"]')?.textContent).toBe("1 件選択中");
  });

  it("同じ同期区間で何度 change が来ても recount は 1 回にまとめる", async () => {
    buildTable();
    attachSelection("cards");
    const boxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[data-select="cards"]'),
    );
    const counter = document.querySelector('[data-select-count="cards"]')!;
    let observedCount = 0;
    const observer = new MutationObserver(() => {
      observedCount += 1;
    });
    observer.observe(counter, { characterData: true, childList: true, subtree: true });

    for (const box of boxes) {
      box.checked = true;
      box.dispatchEvent(new Event("change"));
    }
    await Promise.resolve();
    observer.disconnect();

    expect(counter.textContent).toBe("3 件選択中");
    // 3 回の change に対して、書き換えは 1 回だけ（質的な確認。回数の
    // 厳密な上限ではなく「3 回起きていない」ことだけを見る）。
    expect(observedCount).toBeLessThan(boxes.length);
  });

  it("全選択は hidden を外し、全部チェックする", () => {
    buildTable();
    attachSelection("cards");
    const selectAll = document.querySelector<HTMLInputElement>('input[data-select-all="cards"]')!;
    expect(selectAll.hidden).toBe(false);

    selectAll.checked = true;
    selectAll.dispatchEvent(new Event("change"));

    const boxes = document.querySelectorAll<HTMLInputElement>('input[data-select="cards"]');
    expect(Array.from(boxes).map((b) => b.checked)).toEqual([true, true, true]);
    expect(document.querySelector('[data-select-count="cards"]')?.textContent).toBe("3 件選択中");
  });

  it("全選択は、いま見えている行だけを選ぶ（絞り込みで隠れた行は選ばない）", () => {
    buildTable();
    const rows = document.querySelectorAll<HTMLElement>("tbody > tr");
    rows[2]!.hidden = true; // c の行だけ絞り込みで隠れている想定。

    attachSelection("cards");
    const selectAll = document.querySelector<HTMLInputElement>('input[data-select-all="cards"]')!;
    selectAll.checked = true;
    selectAll.dispatchEvent(new Event("change"));

    const boxes = document.querySelectorAll<HTMLInputElement>('input[data-select="cards"]');
    // a, b は選ばれる。隠れている c は選ばれない。
    expect(Array.from(boxes).map((b) => b.checked)).toEqual([true, true, false]);
  });

  it("一部だけ選ばれていると全選択は indeterminate になる", async () => {
    buildTable();
    attachSelection("cards");
    const [a] = document.querySelectorAll<HTMLInputElement>('input[data-select="cards"]');
    a!.checked = true;
    a!.dispatchEvent(new Event("change"));
    await Promise.resolve();

    const selectAll = document.querySelector<HTMLInputElement>('input[data-select-all="cards"]')!;
    expect(selectAll.indeterminate).toBe(true);
    expect(selectAll.checked).toBe(false);
  });

  it("group に一致するチェックボックスが無ければ何もしない", () => {
    document.body.innerHTML = `<p>何も無い</p>`;
    expect(() => attachSelection("nothing")).not.toThrow();
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

  /**
   * 選択中タブの視覚的な強調（指摘: 3b）。
   *
   * **`client-detail-page.tsx` / `card-detail-page.tsx` を import しない。**
   * あの 2 つは Workers 本体の `tsconfig.json`（`Env` 等の ambient 型あり）
   * 向けで、このファイル（`ui/client/**`）は DOM 型だけを持つ
   * `tsconfig.client.json` 側——`../csrf` 経由で `composition/container.ts`
   * （DI 本体、DB・RPC gateway を抱える）まで import グラフが伸び、
   * `Env` / `Fetcher` / `D1Database` が解決できず型検査が落ちる（最初の
   * 実装でこれをやって踏んだ）。**ここでは実在する画面と同じ class
   * 文字列をそのまま埋め込んで**検査する——`TAB_BUTTON_CLASS` が実際の
   * 2 画面と一致していることは `test/tab-highlight.test.ts`（workerd 側、
   * 実在のルートを fetch する）が別途見ている。
   *
   * **空でも緑になる形にしない。** `[aria-selected="true"]` が 1 つも
   * 無ければ、その後の class の検査は何もしないまま通ってしまう
   * ——件数を先に assert してから中身を見る。
   */
  it("選択中のタブに強調用の class が付く", () => {
    const TAB_BUTTON_CLASS =
      "px-3 py-2 text-sm font-medium text-foreground-muted border-b-2 " +
      "border-transparent -mb-px hover:text-foreground aria-selected:border-primary " +
      "aria-selected:text-foreground";
    document.body.innerHTML = `
      <div data-tabs>
        <button data-tab="a" class="${TAB_BUTTON_CLASS}">A</button>
        <button data-tab="b" class="${TAB_BUTTON_CLASS}">B</button>
        <section data-panel="a">panel A</section>
        <section data-panel="b">panel B</section>
      </div>
    `;
    const root = document.querySelector<HTMLElement>("[data-tabs]")!;
    attachTabs(root);

    const selected = root.querySelectorAll('[aria-selected="true"]');
    expect(selected.length).toBeGreaterThan(0);
    for (const button of selected) {
      expect(button.className).toContain("aria-selected:border-primary");
      expect(button.className).toContain("aria-selected:text-foreground");
    }
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
