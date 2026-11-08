/**
 * GDG のクレイ（claymorphism）の陰影とリングの輪郭が、配信 CSS の
 * `shadow-*` ユーティリティの合成に両方生きているかを調べる（GDG デザイン
 * 移行 PR3）。
 *
 * ## 何を確かめたいか
 *
 * `theme.css` の `--shadow-sm` 等は `0 0 0 1px var(--border), var(--gdg-shadow-sm)`
 * の形で、**輪郭のリングと GDG のクレイを合成**している。だが Tailwind v4 は
 * `shadow-*` ユーティリティを生成するとき、値の末尾の色を
 * `var(--tw-shadow-color, <元の色>)` へ静的に置き換える——多段かつ `inset` を
 * 含む値を渡したときにこの分解が崩れていないか（リングが消えていないか、
 * クレイの inset が削られていないか）は実測でしか分からない。
 *
 * `--tw-shadow:` の宣言そのものに `var(--gdg-shadow-*)` が残っているかを見る。
 * クレイ自体の中身（inset を含むかどうか）は、`--gdg-shadow-*` トークンの
 * 定義そのもの（vendored `tokens.css` が `@import` で配信 CSS に展開されて
 * 入っている）を見て確かめる——ブラウザは `var()` の入れ子をペイント時に
 * 解決するので、配信 CSS の文字列としては `var(--gdg-shadow-sm)` という
 * 参照のまま残り、展開済みの値は出てこない。
 */

/** 配信 CSS が持つ `--tw-shadow:` 宣言のうち、GDG のクレイトークンを合成しているものの値。 */
export function shadowDeclsWithClay(css: string): readonly string[] {
  return [...css.matchAll(/--tw-shadow:([^;]*);/g)]
    .map((m) => m[1] ?? "")
    .filter((decl) => decl.includes("--gdg-shadow-"));
}

/** 配信 CSS に展開されている `--gdg-shadow-sm` / `-md` / `-lg` トークン定義の値。 */
export function gdgShadowTokenDefs(css: string): readonly string[] {
  return [...css.matchAll(/--gdg-shadow-(?:sm|md|lg):([^;]*);/g)].map((m) => m[1] ?? "");
}
