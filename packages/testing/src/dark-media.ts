/**
 * `prefers-color-scheme: dark` の @media ブロックが持つカスタムプロパティ名を
 * 取り出す（GDG デザイン移行 PR1）。
 *
 * ## 何を確かめたいか
 *
 * `packages/web-ui/test/gdg-dark-media.test.ts` は、`tokens.css` の `.dark`
 * ブロックと生成物（`generated/dark-media.css`）の変数名の集合が一致する
 * ことを見ている。だが**生成物が正しくても、それが Tailwind の
 * `optimize: true`（Lightning CSS）と `@layer` の順序をくぐり抜けて実際に
 * 配信されるバイト列まで届いているか**は別の話——`theme.css` の
 * `@import "../gdg/generated/dark-media.css"` を 1 行消しても、生成物側の
 * テストは全部緑のまま通る。各 Worker の `KIWA_STYLESHEET_PATH` を実際に
 * fetch した本文へ、ここで同じ比較をもう一段かける。
 *
 * `.dark { ... }` ブロックの抽出にも、この @media ブロックの抽出にも同じ
 *「開始マーカーの直後から波括弧の対応を数える」方式を使う——正規表現で
 * ブロック全体を一発で取ろうとすると、中に `{` が増えた瞬間に壊れる。
 */

function varNamesInBlock(css: string, openPattern: RegExp): Set<string> {
  const openMatch = openPattern.exec(css);
  if (openMatch === null) return new Set();

  let depth = 1;
  let i = openMatch.index + openMatch[0].length;
  const bodyStart = i;
  for (; i < css.length && depth > 0; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") depth -= 1;
  }
  if (depth !== 0) return new Set();

  const body = css.slice(bodyStart, i - 1);
  const names = new Set<string>();
  for (const m of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) {
    const name = m[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/** vendored `tokens.css` の `.dark { ... }` が宣言する変数名の集合。 */
export function darkClassVarNames(tokensCss: string): Set<string> {
  return varNamesInBlock(tokensCss, /\.dark\s*\{/);
}

/**
 * 配信 CSS の `@media (prefers-color-scheme: dark) { ... }` が宣言する
 * 変数名の集合。整形済み・最小化済みどちらの空白の入り方にもマッチする。
 * ブロックが見つからなければ空集合を返す——**呼び出し側が件数 > 0 を
 * 必ず assert すること**（ここでは例外を投げない。「ブロックが無い」こと
 * 自体をテストで検出させるため）。
 */
export function darkMediaVarNames(css: string): Set<string> {
  return varNamesInBlock(css, /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/);
}
