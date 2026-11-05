/**
 * admin-worker 最初のクライアント JS（#470）。
 *
 * **全画面の前提にしない。** ここが足すのは並べ替え・絞り込み・コピー・
 * タブ・通知のトーストだけで、どれも「無くても読める・無くても操作できる」
 * ものの上に乗る後付けの便利さである。読み込みに失敗しても、CSP で弾かれ
 * ても、JS を切っていても、画面は（並べ替え前の既定順・全行表示・タブなら
 * 縦一列で）そのまま成立する。
 *
 * ## `data-*` 属性がセッション間の契約である
 *
 * `/audit` `/clients` `/nfc/analytics` 以外の画面（#471〜#473）も同じ属性を
 * 自分の HTML に付けて、この 1 本を読み込むだけで動くようにする。属性の形は
 * `./README.md` の表を正とする——ここにも書くと 2 箇所がずれる。
 *
 * ## CSP（`script-src 'self'`）
 *
 * インライン `<script>` も `onclick` も通らない。この外部ファイル 1 本と
 * `addEventListener` だけで作ってあり、nonce は使わない（他 3 Worker と
 * 同じ縛りのまま）。
 */

// ----------------------------------------------------------------- 並べ替え

type SortKind = "text" | "number" | "date";

/** `<th data-sort>` が持つ列の、同じ行内でのセル番号。 */
function cellIndexOf(th: HTMLElement): number {
  return Array.prototype.indexOf.call(th.parentElement?.children ?? [], th);
}

export function sortValueOf(cell: Element | undefined, kind: SortKind): string | number {
  const text = cell?.textContent?.trim() ?? "";
  if (kind === "number") {
    // **空文字を先に弾く。** `Number("")` は `NaN` ではなく `0` を返すので、
    // 空欄のセルが「0」として並んでしまう（実測）。数字が無ければ常に
    // 最後尾に回す。
    if (text === "") return Number.NEGATIVE_INFINITY;
    // 桁区切りのカンマだけ落とす。
    const n = Number(text.replace(/,/g, ""));
    return Number.isNaN(n) ? Number.NEGATIVE_INFINITY : n;
  }
  if (kind === "date") {
    const t = Date.parse(text);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  }
  return text;
}

export function attachSortableTable(table: HTMLTableElement): void {
  const headRow = table.querySelector("thead tr");
  const body = table.querySelector("tbody");
  if (headRow === null || body === null) return;

  const headers = Array.from(headRow.querySelectorAll<HTMLElement>("[data-sort]"));
  if (headers.length === 0) return;

  let activeHeader: HTMLElement | null = null;
  let ascending = true;

  for (const th of headers) {
    const kind = th.getAttribute("data-sort") as SortKind;
    const label = th.textContent ?? "";

    // **見出しの文字をボタンへ差し替える。** `<th>` のままではキーボードで
    // 辿れず、クリックできることも伝わらない。JS が無ければこのボタンは
    // 生まれず、`<th>` は見出しの文字のままである（押せないだけで読める）。
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "flex items-center gap-1 text-left text-xs font-medium text-foreground-muted hover:text-foreground";
    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    const arrow = document.createElement("span");
    arrow.className = "text-foreground-soft";
    arrow.setAttribute("aria-hidden", "true");
    button.append(labelSpan, arrow);
    th.textContent = "";
    th.append(button);

    button.addEventListener("click", () => {
      ascending = activeHeader === th ? !ascending : true;
      activeHeader = th;

      for (const other of headers) {
        other.removeAttribute("aria-sort");
        const otherArrow = other.querySelector("span[aria-hidden]");
        if (otherArrow !== null) otherArrow.textContent = "";
      }
      th.setAttribute("aria-sort", ascending ? "ascending" : "descending");
      arrow.textContent = ascending ? "▲" : "▼";

      const index = cellIndexOf(th);
      const rows = Array.from(body.querySelectorAll<HTMLTableRowElement>(":scope > tr"));
      rows.sort((a, b) => {
        const va = sortValueOf(a.children[index], kind);
        const vb = sortValueOf(b.children[index], kind);
        if (va < vb) return ascending ? -1 : 1;
        if (va > vb) return ascending ? 1 : -1;
        return 0;
      });
      for (const row of rows) body.append(row);
    });
  }
}

// ------------------------------------------------------------------- 絞り込み

/**
 * `data-filter="<id>"` の対象（`<table>` か `<ul>`）から、直接の行を取る。
 *
 * **対象をテーブルに限定しない。** `/clients` の一覧は `<ul>` なので、
 * `tr` と `li` の両方を見る（`README.md` の「絞り込み」を参照——叩き台から
 * 変えた点）。
 */
export function rowsOf(target: Element): readonly HTMLElement[] {
  if (target.tagName === "TABLE") {
    return Array.from(target.querySelectorAll<HTMLElement>("tbody > tr"));
  }
  return Array.from(target.querySelectorAll<HTMLElement>(":scope > li"));
}

export function attachFilter(input: HTMLInputElement): void {
  const targetId = input.getAttribute("data-filter");
  const target = targetId === null ? null : document.getElementById(targetId);
  if (target === null) return;

  const rows = rowsOf(target);
  if (rows.length === 0) return;

  // **件数を出す。** 絞り込みで隠した行ぶん、画面のどこかの「全 N 件」が
  // 嘘になりうる（指摘: 3b）。ここで作る件数表示が常に正しい分母・分子に
  // なるようにする——ページ側が別に総数を出している場合は、そちらを
  // 生かすかどうかはページ側の判断（`data-filter-count` を参照）。
  const count = document.createElement("p");
  count.className = "text-xs text-foreground-soft";
  input.insertAdjacentElement("afterend", count);

  const externalCount =
    targetId === null ? null : document.querySelector(`[data-filter-count="${targetId}"]`);

  function apply(): void {
    const query = input.value.trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const matches = query === "" || (row.textContent?.toLowerCase().includes(query) ?? false);
      row.hidden = !matches;
      if (matches) shown += 1;
    }
    const text =
      query === "" ? `${rows.length} 件` : `${shown} / ${rows.length} 件（この一覧から絞り込み）`;
    count.textContent = text;
    if (externalCount !== null) externalCount.textContent = String(shown);
  }

  input.addEventListener("input", apply);
  input.hidden = false;
  apply();
}

// --------------------------------------------------------------------- コピー

async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "コピーしました";
  } catch {
    // クリップボード API が無い・許可されない。選択してのコピーへ逃がす。
    button.textContent = "コピーできません（選択してコピーしてください）";
  }
  window.setTimeout(() => {
    button.textContent = original;
  }, 2000);
}

export function attachCopyButton(button: HTMLButtonElement): void {
  const text = button.getAttribute("data-copy");
  if (text === null) return;
  button.hidden = false;
  button.addEventListener("click", () => {
    void copyText(text, button);
  });
}

// ----------------------------------------------------------------------- タブ

/**
 * `data-tabs` / `data-tab` / `data-panel`（#470 の契約だが、この issue の
 * 3 画面では使わない——#454 の解析 6 区画は縦一列のままにする、という
 * 明示の判断による）。**契約として渡す以上、未使用のまま置かない**
 * （指摘: 3b）。挙動は `admin-island.test.ts` で、見本は
 * `scripts/preview-html.generator.mts` の `tabs-sample` で確かめている。
 */
export function attachTabs(root: HTMLElement): void {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-tab]"));
  if (buttons.length === 0) return;

  const panelOf = (key: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-panel="${key}"]`);

  function show(key: string): void {
    for (const button of buttons) {
      const isActive = button.getAttribute("data-tab") === key;
      button.setAttribute("aria-selected", String(isActive));
      const panel = panelOf(button.getAttribute("data-tab") ?? "");
      if (panel !== null) panel.hidden = !isActive;
    }
  }

  for (const button of buttons) {
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => {
      const key = button.getAttribute("data-tab");
      // **`data-panel` が無い `data-tab` を押しても落ちない。** `panelOf` が
      // `null` を返すだけで、他のパネルの開閉には影響しない。
      if (key !== null) show(key);
    });
  }

  // 既定で 1 枚目だけを表示する。JS が無いときは `hidden` を誰も付けない
  // ので、全パネルが見出し付きで縦に並ぶ（絶対条件）。
  const firstKey = buttons[0]?.getAttribute("data-tab");
  if (firstKey !== null && firstKey !== undefined) show(firstKey);
}

// ----------------------------------------------------------------- 吹き出し

/**
 * `data-tip="<文字列>"` を持つ要素（`/nfc/analytics` のグラフの `<rect>`）に
 * ホバー/フォーカスで吹き出しを出す。
 *
 * **`title` 属性に頼らない。** ブラウザ既定のツールチップは遅く、見た目も
 * 選べない——運用者から「デザインに AI 味が強い」「Vercel っぽく」と
 * 繰り返し言われている画面なので、Kiwa の色トークンに合わせた小さな
 * カードを自前で出す。
 *
 * **1 つの吹き出し要素を使い回す。** 要素の数ぶん `<div>` を作ると、
 * グラフ 1 本（最大 180 本の `<rect>`）でその数ぶん DOM が増える。
 */
export function attachTooltips(targets: readonly HTMLElement[]): void {
  if (targets.length === 0) return;

  const tip = document.createElement("div");
  tip.className =
    "pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-card px-2 py-1 text-xs whitespace-nowrap text-foreground shadow-md";
  tip.hidden = true;
  document.body.append(tip);

  function show(target: HTMLElement): void {
    const text = target.getAttribute("data-tip");
    if (text === null) return;
    const rect = target.getBoundingClientRect();
    tip.textContent = text;
    tip.style.left = `${rect.left + rect.width / 2}px`;
    tip.style.top = `${rect.top - 4}px`;
    tip.hidden = false;
  }

  function hide(): void {
    tip.hidden = true;
  }

  for (const target of targets) {
    target.addEventListener("mouseenter", () => show(target));
    target.addEventListener("mouseleave", hide);
    // **キーボードでも辿れる。** `<rect>` は既定でフォーカスを受けないので
    // `tabindex="0"` を足す——マウスだけの機能にしない。
    target.setAttribute("tabindex", "0");
    target.addEventListener("focus", () => show(target));
    target.addEventListener("blur", hide);
  }
}

// --------------------------------------------------------------------- 通知

/**
 * `[data-notice]` を見つけたらトースト化する。
 *
 * **要素自体は消さない。** トーストは複製であって移動ではないので、
 * 自動で消えたあとも同じ文が本文に残っている（絶対条件）。
 *
 * **`?notice=` を読まない。** `/users` のようにコードを URL へ積む画面は
 * サーバー側で既に人の読む文へ変換している——ここでコードから文を
 * 組み直すと、同じ文言が 2 箇所（サーバーとこの島）に分かれる
 * （指摘: 3b。`README.md` の「通知」を参照）。
 */
export function attachNoticeToast(el: HTMLElement): void {
  const text = el.textContent?.trim();
  if (text === undefined || text === "") return;

  const toast = document.createElement("div");
  toast.setAttribute("role", "status");
  toast.className =
    "fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg transition-opacity";
  toast.textContent = text;
  document.body.append(toast);

  window.setTimeout(() => {
    toast.classList.add("opacity-0");
    window.setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// --------------------------------------------------------------------- 起動

for (const table of document.querySelectorAll<HTMLTableElement>("table[data-sortable]")) {
  attachSortableTable(table);
}
for (const input of document.querySelectorAll<HTMLInputElement>("input[data-filter]")) {
  attachFilter(input);
}
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  attachCopyButton(button);
}
for (const root of document.querySelectorAll<HTMLElement>("[data-tabs]")) {
  attachTabs(root);
}
attachTooltips(Array.from(document.querySelectorAll<HTMLElement>("[data-tip]")));
for (const notice of document.querySelectorAll<HTMLElement>("[data-notice]")) {
  attachNoticeToast(notice);
}
