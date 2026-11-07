/**
 * `pnpm preview:html` の `index.html`（シェル）を組み立てる（services-3b の
 * 依頼：GDG 移行 PR1 の受け入れ条件「17 画面をライト/ダーク両方で目視」を、
 * DevTools でのタブごとの手動切り替えなしで行えるようにする）。
 *
 * ## なぜここを分けたか
 *
 * **`preview-html.generator.mts` から呼ぶが、Node 専用 API を一切使わない。**
 * あちらは `node:fs/promises` を読む（出力先への書き出し）が、ここは
 * 文字列を組み立てて返すだけ——`test/` 配下の DOM が要るテスト
 * （`vitest.client.config.ts`、happy-dom）から素通りで import できる。
 * `node:fs` を混ぜると、happy-dom 環境でも Node の型解決が要るようになり、
 * `tsconfig.client.json`（DOM 専用、Node の型を持ち込まない方針——
 * `tsconfig.client.json` 自身のコメントを参照）の前提と衝突する。
 *
 * ## 切り替えボタンは各ページの HTML に無い
 *
 * `preview-html.generator.mts` が書き出す 17 画面（`home.html` 等）は、
 * `createApp()` が実際に返す HTML を `withLocalStylesheet`/`withLocalIsland`
 * で相対パスに直しただけで、**本文は 1 バイトも変えていない**。切り替え
 * ボタンはここ（`index.html`）だけが持つ——各ページを `<iframe srcdoc>` で
 * そのまま読み込み、`iframe.contentDocument.documentElement` に
 * `class="light"`/`class="dark"` を直接付け外しする。
 *
 * **`<iframe src="home.html">` ではなく `srcdoc` にした理由。** `file://`
 * で開いたとき、`src` 経由の iframe は親から見て別オリジン扱いになり
 * `contentDocument` が `null` を返す（実測、Chrome）。`srcdoc` はビルド時に
 * 持っている文字列をその場に埋め込むので、この制限を受けない
 * （これも実測——同じ Chrome で `srcdoc` 側は `contentDocument` を返す）。
 *
 * ## PR1（GDG デザイン移行）への依存
 *
 * `.light`/`.dark` を `<html>` に付けて実際に色が変わるかどうかは、
 * `packages/web-ui/src/kiwa/theme.css` が GDG のトークン（`:root,.light` /
 * `.dark`）へ寄っていることが前提——まだ main に入っていない。入るまでは
 * クラスは付くが見た目は変わらない。ここの検査が見るのは「クラスが実際に
 * 切り替わること」で、「色が変わること」は PR1 が入ったあとに目視で見る
 * （services-3b の指示）。
 */

/** `preview-html.generator.mts` の `PreviewPage` と同じ形。ここが正本。 */
export type PreviewPage = {
  readonly name: string;
  readonly title: string;
  readonly html: string;
};

/**
 * ページの HTML を `<script>` の中の文字列リテラルとして埋め込めるようにする。
 *
 * `JSON.stringify` だけでは足りない——17 画面のうち `home.html` 等は本物の
 * `<script type="module" src="./admin-island.js">` を自分の本文に持つ。
 * その `</script` という文字の並びは、**JS の文字列としては何でもないが、
 * HTML パーサーにとっては「ここで script 要素が終わる」という合図**
 * （ブラウザは `<script>` の中身を JS として読む前に、まず素のテキストとして
 * `</script` を探す）。エスケープしないと、埋め込んだページの `</script>`
 * の時点で外側の `<script>` が閉じてしまい、そのあとに続くはずの JS
 * （他のページのデータやボタンの配線）が本文としてそのまま描画される。
 */
function embedAsScriptString(value: string): string {
  return JSON.stringify(value).replace(/<\/script/gi, "<\\/script");
}

const THEME_MODES = ["system", "light", "dark"] as const;
type ThemeMode = (typeof THEME_MODES)[number];

const THEME_LABELS: Record<ThemeMode, string> = {
  system: "OS 追従",
  light: "ライト固定",
  dark: "ダーク固定",
};

/**
 * `main()` が書き出す `index.html` の本体。
 *
 * **ページの一覧（`<nav>` のリンク）は `href` も残す。** クリックしたときは
 * `preventDefault()` して iframe に差し替えるが、JS が動かない・または
 * 右クリックで新しいタブに開きたい場合は、ふつうのページ遷移として
 * そのまま動く（他の画面が JS 無しでも読めることと同じ理由）。
 */
export function buildPreviewIndexHtml(pages: readonly PreviewPage[]): string {
  if (pages.length === 0) {
    throw new Error("buildPreviewIndexHtml: pages が空です（画面が 1 つも無い）");
  }

  const navItems = pages
    .map((p) => `<li><a href="./${p.name}.html" data-page="${p.name}">${p.title}</a></li>`)
    .join("\n");

  const themeButtons = THEME_MODES.map(
    (mode) => `<button type="button" data-theme-mode="${mode}">${THEME_LABELS[mode]}</button>`,
  ).join("\n");

  const pagesEntries = pages
    .map((p) => `${JSON.stringify(p.name)}: ${embedAsScriptString(p.html)}`)
    .join(",\n");

  const firstPageName = pages[0]!.name;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<title>admin-worker HTML プレビュー</title>
<link rel="stylesheet" href="./kiwa.css" />
<style>
  html, body { margin: 0; height: 100%; }
  body { display: flex; flex-direction: column; font-family: system-ui, sans-serif; color: #111; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem 1rem; border-bottom: 1px solid #ccc; }
  header p { margin: 0; font-size: 0.8rem; color: #555; }
  .theme-toggle { display: flex; gap: 0.5rem; }
  .theme-toggle button { font-size: 0.85rem; padding: 0.3rem 0.6rem; cursor: pointer; }
  .theme-toggle button[aria-pressed="true"] { outline: 2px solid #3b82f6; font-weight: 700; }
  nav.pages { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; padding: 0.5rem 1rem; border-bottom: 1px solid #ccc; margin: 0; list-style: none; }
  nav.pages ul { display: contents; }
  nav.pages li { display: contents; }
  nav.pages a { font-size: 0.8rem; text-decoration: none; }
  nav.pages a[aria-current="page"] { font-weight: 700; text-decoration: underline; }
  iframe { flex: 1; width: 100%; border: 0; }
</style>
</head>
<body>
<header>
  <div>
    <strong>admin-worker HTML プレビュー</strong>
    <p>すべて架空のデータです。本番には一切繋がっていません。</p>
  </div>
  <div class="theme-toggle" role="group" aria-label="配色の切り替え（プレビュー専用、本番の画面には無い）">
${themeButtons}
  </div>
</header>
<nav class="pages" aria-label="画面の一覧">
<ul>
${navItems}
</ul>
</nav>
<iframe id="preview-frame" title="プレビュー本体"></iframe>
<script>
(function () {
  "use strict";
  var PAGES = {
${pagesEntries}
  };
  var STORAGE_KEY = "u18-preview-theme";
  var iframe = document.getElementById("preview-frame");
  var themeButtons = document.querySelectorAll("[data-theme-mode]");
  var navLinks = document.querySelectorAll("nav.pages a[data-page]");

  function currentMode() {
    var stored = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      stored = null;
    }
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
    return "system";
  }

  function applyModeToRoot(root, mode) {
    if (!root) return;
    root.classList.remove("light", "dark");
    if (mode === "light") root.classList.add("light");
    if (mode === "dark") root.classList.add("dark");
  }

  function setMode(mode) {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch (e) {
      // プレビューの利便性のためだけの保存。失敗しても切り替え自体は続く。
    }
    var doc = iframe.contentDocument;
    applyModeToRoot(doc ? doc.documentElement : null, mode);
    themeButtons.forEach(function (btn) {
      btn.setAttribute("aria-pressed", btn.dataset.themeMode === mode ? "true" : "false");
    });
  }

  themeButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setMode(btn.dataset.themeMode);
    });
  });

  // ページを切り替えるたびに iframe の中身は新しい document に入れ替わる
  // （srcdoc の再代入）ので、load のたびに「いま選ばれている配色」を
  // 改めて当て直す。付け忘れると「1 枚目はダークなのに次の画面はライトの
  // まま」という事故になる。
  iframe.addEventListener("load", function () {
    applyModeToRoot(iframe.contentDocument.documentElement, currentMode());
  });

  function showPage(name) {
    var html = PAGES[name];
    if (html === undefined) return;
    iframe.srcdoc = html;
    navLinks.forEach(function (a) {
      if (a.dataset.page === name) {
        a.setAttribute("aria-current", "page");
      } else {
        a.removeAttribute("aria-current");
      }
    });
  }

  navLinks.forEach(function (a) {
    a.addEventListener("click", function (ev) {
      ev.preventDefault();
      showPage(a.dataset.page);
    });
  });

  setMode(currentMode());
  showPage(${JSON.stringify(firstPageName)});
})();
</script>
</body>
</html>
`;
}
