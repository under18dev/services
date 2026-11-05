/**
 * admin-worker 最初のクライアント JS（#470、選択・一括操作は #481）。
 *
 * **全画面の前提にしない。** ここが足すのは並べ替え・絞り込み・選択の
 * 件数表示 / 全選択・コピー・タブ・通知のトーストだけで、どれも「無くても
 * 読める・無くても操作できる」ものの上に乗る後付けの便利さである
 * （選択そのもの・一括操作の送信は素の form で成立する——`attachSelection`
 * の JSDoc を参照）。読み込みに失敗しても、CSP で弾かれても、JS を切って
 * いても、画面は（並べ替え前の既定順・全行表示・タブなら縦一列で）
 * そのまま成立する。
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
    // **末尾の「 JST」を落としてから読む。** `ui/format.ts` の
    // `formatDateTime` は `Intl.DateTimeFormat("ja-JP")` の
    // 「YYYY/MM/DD HH:MM」に ` JST` を足した文字列を返す。スラッシュ
    // 区切りの非 ISO 形式は `Date.parse` が読めるが、**末尾にタイムゾーン
    // の略称が付くと丸ごと `NaN` になる**（実測、V8——`/audit` 本体を
    // 含む `data-sort="date"` の列が、足した #470 の時点から今日まで
    // 「押しても並びが変わらない」まま気づかれずに残っていた）。
    //
    // ## admin-worker に日時の書式が 2 つあることと繋がっている（#488）
    //
    // `nfc-page.tsx` の `toDate()`（カードの発行日を「YYYY-MM-DD」だけで
    // 出す、時刻も JST も付けない別の整形）は、素の ISO 日付なので
    // `Date.parse` にそのまま通り、このバグを踏んでいない。**このバグが
    // `formatDateTime` 側だけで起きていたのは、書式が 1 つしか無いからでは
    // なく、たまたま 2 つのうち片方だけ運良く `Date.parse` と相性が良い
    // 形をしていたから**である。次に誰かが `toDate()` を `formatDateTime`
    // へ揃えたら、ここの `.replace()` が無いと同じ「押しても並びが変わら
    // ない」が `/nfc` の「発行」列にも広がる——書式を統一する側ではなく、
    // **ここ（並べ替え側）が両方の書式を受け止められることを保証する**
    // 作りにしてある。
    //
    // 落としたあとの文字列をどのタイムゾーンとして読むかは関知しない
    // ——ここは並べ替えの相対順序だけが要るので、どのセルも同じだけ
    // ずれれば順序は変わらない。表示用の絶対時刻には使わない。
    const withoutTimezoneName = text.replace(/\s+[A-Za-z]+$/, "");
    const t = Date.parse(withoutTimezoneName);
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
      if (matches) {
        shown += 1;
        continue;
      }
      // **隠した行の選択を外す（#481）。** CSS の `hidden` は form の
      // 送信を止めない——チェックの付いたまま隠れると、運用者が見ていない
      // 行まで一括操作の対象になる。`change` を飛ばすのは、
      // `attachSelection` 側の件数表示・全選択の状態を同期させるため。
      for (const checkbox of row.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
        if (!checkbox.checked) continue;
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      }
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

// --------------------------------------------------------------------- 選択

/**
 * チェックボックスの行（`<tr>` か `<li>`、`rowsOf` と同じ定義）。見つから
 * なければチェックボックス自身を行として扱う——行の外（表に入っていない
 * 単独のチェックボックス）でも壊れないようにするため。
 */
function rowOf(checkbox: HTMLInputElement): HTMLElement {
  return checkbox.closest<HTMLElement>("tr, li") ?? checkbox;
}

/** 絞り込みで隠れていない行のチェックボックスだけを返す（#481）。 */
function visibleCheckboxesOf(checkboxes: readonly HTMLInputElement[]): HTMLInputElement[] {
  return checkboxes.filter((checkbox) => !rowOf(checkbox).hidden);
}

/**
 * 一括操作のための選択（#481）。
 *
 * **一覧の 1 行ずつの操作を無くし、選択 + 一括操作へ置き換える**
 * （運用者の指示：「カード一覧からは 1 枚ずつ操作できなくていい。
 * 詳細ページからやる。代わりにソート・検索・選択 and 一括操作を」）。
 *
 * ## 選択そのものは JS を要求しない
 *
 * `<input type="checkbox" data-select name="card_id" value="...">` は
 * ただの form 要素。JS が落ちても、チェックして送信ボタンを押せば
 * 一括操作は成立する——**ここが足すのは「N 件選択中」の件数表示と
 * 「表示中を全選択」だけ**（絶対条件）。操作ボタン自体を隠したり
 * 無効化したりしない。
 *
 * ## 「全選択」が選ぶのは、いま見えている行だけ
 *
 * `rows.hidden` が `true` な行（絞り込みで隠れている）は対象外にする。
 * **理由: 一覧は `truncated` で打ち切られることもあり、絞り込み中に
 * 「全部選んだ」と運用者に読ませると、見ていないカードを止め損なう・
 * 見ていないカードまで止める、という事故になる**（issue 本文）。
 *
 * ## 絞り込みを変えたら選択も見直す
 *
 * このファイル自身の責務ではなく、`attachFilter` 側が「隠した行の
 * チェックを外して `change` を飛ばす」ところまでやる——ここはその
 * `change` を拾って件数と「全選択」の状態を更新するだけでよい。
 * 2 つの機能を直接結合させない（`attachFilter` は selection の存在を
 * 知らない）ための役割分担。
 */
export function attachSelection(group: string): void {
  const checkboxes = Array.from(
    document.querySelectorAll<HTMLInputElement>(`input[data-select="${group}"]`),
  );
  if (checkboxes.length === 0) return;

  const selectAll = document.querySelector<HTMLInputElement>(`input[data-select-all="${group}"]`);
  const counters = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-select-count="${group}"]`),
  );

  function recount(): void {
    const visible = visibleCheckboxesOf(checkboxes);
    const checked = visible.filter((checkbox) => checkbox.checked);

    for (const counter of counters) counter.textContent = `${checked.length} 件選択中`;

    if (selectAll !== null) {
      // **`indeterminate` は属性ではなくプロパティ。** HTML に書けないので
      // JS からしか立てられない——立てないと「一部だけ選択」のときに
      // 全選択チェックボックスが素の on/off のどちらかに丸められ、
      // 「もう一度押すと何が起きるか」が読み取れない。
      selectAll.checked = visible.length > 0 && checked.length === visible.length;
      selectAll.indeterminate = checked.length > 0 && checked.length < visible.length;
    }
  }

  /**
   * `recount()` を 1 つのマイクロタスクへまとめる（500 行での実測、
   * 3b の依頼）。
   *
   * **`attachFilter` が絞り込みで隠した行のチェックを 1 件ずつ外し、
   * 1 件ごとに `change` を飛ばす。** 全選択してから絞り込むと、500 行の
   * 表で 1 回のキー入力につき最大 500 回 `change` が飛び、素朴に毎回
   * `recount()`（`visibleCheckboxesOf` が 500 件を舐める）を呼ぶと
   * 最悪 O(選択数 × 行数) になる——実測（happy-dom、500 行、全選択後に
   * 450 行を隠す）で **24ms** かかっていた。
   *
   * 同じ同期区間で何度 `change` が来ても、実際に `recount()` を走らせる
   * のは次のマイクロタスクで 1 回だけにする——同じ実測で **3ms 未満**
   * まで落ちた。ユーザーが直接チェックを 1 つ押したときも経路は同じだが、
   * マイクロタスクは次の描画より前に片付くので、体感の遅れは出ない。
   */
  let recountScheduled = false;
  function scheduleRecount(): void {
    if (recountScheduled) return;
    recountScheduled = true;
    queueMicrotask(() => {
      recountScheduled = false;
      recount();
    });
  }

  for (const checkbox of checkboxes) {
    checkbox.addEventListener("change", scheduleRecount);
  }

  if (selectAll !== null) {
    selectAll.hidden = false;
    selectAll.addEventListener("change", () => {
      // **チェックを外すだけのときも「見えている行」に限る。** 絞り込みで
      // 隠れている行はそもそも `attachFilter` がチェックを外しているので、
      // ここで触れても触れなくても結果は同じだが、「全選択が見える範囲
      // だけに効く」という性質を片方の分岐だけに持たせない。
      for (const checkbox of visibleCheckboxesOf(checkboxes)) {
        checkbox.checked = selectAll.checked;
      }
      recount();
    });
  }

  // **起動直後に 1 度呼ぶ。** サーバーが描いた静的な文言（JS 無しの
  // ときに読む文）を、件数つきの文言へ差し替える——「0 件選択中」から
  // 始まる。`data-select-count` を空のまま出さないこと、という絶対条件は
  // サーバー側（呼び出し元）の責務だが、JS が動く場合はここで必ず
  // 上書きされる。
  recount();
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
{
  // **`data-select` を持つ要素から group の集合を取る。** 1 画面に複数の
  // 選択グループを置く可能性を閉じないため、決め打ちの文字列を 1 つだけ
  // 呼ぶのではなく、実際に存在する group をすべて拾う。
  const groups = new Set(
    Array.from(document.querySelectorAll<HTMLInputElement>("input[data-select]"))
      .map((checkbox) => checkbox.getAttribute("data-select"))
      .filter((group): group is string => group !== null),
  );
  for (const group of groups) attachSelection(group);
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
