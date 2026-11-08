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
 *
 * ## `gdgShadowTokenDefs` はライト・ダーク両方から拾う（指摘: 3b）
 *
 * `--gdg-shadow-sm` / `-md` / `-lg` は `:root,.light` とダークの `@media`
 * の両方で定義されるので、配信 CSS には sm/md/lg × 2 系統 = 6 件ある。
 * **呼び出し側は `.every()` で全件を見ること**——`.some()` だと、ダーク側の
 * inset が丸ごと消えてもライト側の 3 件が残っていれば緑のまま通ってしまう。
 *
 * さらに「6 件のうちダーク側に属するものを見ているか」は `.every()` だけ
 * では分からない——#531 で一度踏んだ穴と同じ形で、`count > 0` は「何かを
 * 見つけた」としか言わず「見るべきものを見つけた」とは言わない。ダークの
 * `@media` の中身を直接見るには、既に実績のある `darkMediaVarNames`
 * （`./dark-media`）を再利用し、返ってくる変数名の集合に
 * `--gdg-shadow-sm` / `-md` / `-lg` が入っていることを別 assert すること。
 */

/** 配信 CSS が持つ `--tw-shadow:` 宣言のうち、GDG のクレイトークンを合成しているものの値。 */
export function shadowDeclsWithClay(css: string): readonly string[] {
  return [...css.matchAll(/--tw-shadow:([^;]*);/g)]
    .map((m) => m[1] ?? "")
    .filter((decl) => decl.includes("--gdg-shadow-"));
}

/**
 * 配信 CSS に展開されている `--gdg-shadow-sm` / `-md` / `-lg` トークン定義の
 * 値。ライト（`:root,.light`）・ダーク（`@media` 内の複製）の両方を含む
 * ——呼び出し側は `.every()` で全件を見ること（`.some()` は弱い、上の
 * JSDoc 参照）。
 */
export function gdgShadowTokenDefs(css: string): readonly string[] {
  return [...css.matchAll(/--gdg-shadow-(?:sm|md|lg):([^;]*);/g)].map((m) => m[1] ?? "");
}
