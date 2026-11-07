/**
 * `prefers-color-scheme: dark` の @media ブロックが持つ `--gdg-*` のカスタム
 * プロパティ名を取り出す（GDG デザイン移行 PR1）。
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
 * ブロックの抽出には「開始マーカーの直後から波括弧の対応を数える」方式を
 * 使う——正規表現でブロック全体を一発で取ろうとすると、中に `{` が増えた
 * 瞬間に壊れる。
 *
 * ## `@media (prefers-color-scheme: dark)` は GDG 専用ではない
 *
 * Tailwind 本体も `dark:` バリアント（`@custom-variant dark` を定義して
 * いないので既定の OS 設定ベース）を使う class（例: `button.tsx` の
 * `dark:aria-invalid:ring-destructive/40`）があれば、Tailwind-内部の
 * `--tw-ring-color` 等を宣言する**同じ形の @media** を別に吐く。
 *
 * 実際に `theme.css` の `@import` を外して確かめたとき、**最初に見つかった
 * 1 個だけを見る版は、GDG の生成物ではなくこちらの Tailwind 側の @media を
 * 拾って「ブロックが見つかった」と誤判定した**（件数 > 0 の assert だけ
 * では空集合と区別できない落とし穴の、もう 1 つの形）。
 *
 * 対策は 2 つ重ねてある: (1) 最初の 1 個ではなく、見つかった @media ブロック
 * を**全部**調べる。(2) その中から **`--gdg-` で始まる名前だけ**を残す——
 * Tailwind 側の `--tw-*` は最初から対象外になるので、どちらの @media が
 * 先に出現するかという cascade の出現順に依存しなくなる。
 */

function gdgVarNamesInMatchingBlocks(css: string, openPattern: RegExp): Set<string> {
  const names = new Set<string>();
  const globalPattern = new RegExp(openPattern.source, "g");

  for (const openMatch of css.matchAll(globalPattern)) {
    let depth = 1;
    let i = (openMatch.index ?? 0) + openMatch[0].length;
    const bodyStart = i;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
    }
    if (depth !== 0) continue;

    const body = css.slice(bodyStart, i - 1);
    for (const m of body.matchAll(/(--gdg-[a-zA-Z0-9-]+)\s*:/g)) {
      const name = m[1];
      if (name !== undefined) names.add(name);
    }
  }

  return names;
}

/** vendored `tokens.css` の `.dark { ... }` が宣言する `--gdg-*` 変数名の集合。 */
export function darkClassVarNames(tokensCss: string): Set<string> {
  return gdgVarNamesInMatchingBlocks(tokensCss, /\.dark\s*\{/);
}

/**
 * 配信 CSS の `@media (prefers-color-scheme: dark) { ... }` が宣言する
 * `--gdg-*` 変数名の集合。整形済み・最小化済みどちらの空白の入り方にも
 * マッチし、該当する @media が複数あっても全部を調べる。ブロックが
 * 1 つも見つからなければ空集合を返す——**呼び出し側が件数 > 0 を必ず
 * assert すること**（ここでは例外を投げない。「ブロックが無い」こと自体を
 * テストで検出させるため）。
 */
export function darkMediaVarNames(css: string): Set<string> {
  return gdgVarNamesInMatchingBlocks(
    css,
    /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/,
  );
}
