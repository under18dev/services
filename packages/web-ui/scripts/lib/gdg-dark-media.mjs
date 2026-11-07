// @ts-check

/**
 * vendored `../../src/gdg/tokens.css` の `.dark { ... }` を
 * `prefers-color-scheme: dark` の @media へ複製する（GDG デザイン移行 PR1）。
 *
 * ## 手で複製しない理由
 *
 * `tokens.css` は `.light`/`.dark` のクラス切り替え前提（上流は
 * next-themes で `<html>` に class を付ける）。u18 にはそのテーマ切り替え UI が
 * 無いので、OS 設定（`prefers-color-scheme`）で切り替える側を別に用意する
 * 必要がある。手で `.dark { ... }` を `@media` 内にコピーすると、上流が
 * トークンを 1 つ足した日にその 1 つだけライトのまま取り残され、誰も
 * 気づかない——だからここで機械的に複製する。
 */

/**
 * `.dark { ... }` ブロック（最初の `{` から対応する `}` まで）を取り出す。
 * ネストした at-rule が将来入っても対応できるよう、波括弧の対応を数えて
 * 終端を探す（正規表現で `.dark { ... }` を丸ごと取ろうとすると、内側に
 * `{` が増えた瞬間に壊れるため）。
 *
 * @param {string} cssText
 * @returns {{ ok: true; body: string } | { ok: false; error: string }}
 */
function extractDarkBlock(cssText) {
  const openMatch = /\.dark\s*\{/.exec(cssText);
  if (openMatch === null) {
    return { ok: false, error: "tokens.css に `.dark { ... }` ブロックが見つかりません。" };
  }

  let depth = 1;
  let i = openMatch.index + openMatch[0].length;
  const bodyStart = i;
  for (; i < cssText.length && depth > 0; i += 1) {
    if (cssText[i] === "{") depth += 1;
    else if (cssText[i] === "}") depth -= 1;
  }

  if (depth !== 0) {
    return { ok: false, error: "tokens.css の `.dark { ... }` の波括弧が対応していません。" };
  }

  return { ok: true, body: cssText.slice(bodyStart, i - 1) };
}

/**
 * `.dark` ブロックの本文から、そこで宣言されているカスタムプロパティ名を
 * 重複無く取り出す。`var(--gdg-foo)` のような参照（コロンが続かない）は
 * 拾わない。
 *
 * @param {string} darkBody
 * @returns {string[]} 出現順、重複無し
 */
function declaredVarNames(darkBody) {
  const seen = new Set();
  const names = [];
  for (const m of darkBody.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) {
    const name = m[1];
    if (name !== undefined && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * @param {string} tokensCssText vendored tokens.css の全文
 * @returns {{
 *   ok: true;
 *   varNames: string[];
 *   content: string;
 * } | {
 *   ok: false;
 *   errors: string[];
 * }}
 */
export function buildDarkMedia(tokensCssText) {
  const extracted = extractDarkBlock(tokensCssText);
  if (!extracted.ok) {
    return { ok: false, errors: [extracted.error] };
  }

  const varNames = declaredVarNames(extracted.body);
  if (varNames.length === 0) {
    // 空のまま緑にしない（#524 以前にこのリポジトリで繰り返し踏んだ形）。
    return {
      ok: false,
      errors: [
        "tokens.css の `.dark { ... }` からカスタムプロパティが 1 つも取れませんでした。" +
          "セレクタの取り違え等でパースが空になっている可能性があります。",
      ],
    };
  }

  const indentedBody = extracted.body
    .split("\n")
    .map((line) => (line.trim().length === 0 ? "" : `      ${line.trim()}`))
    .filter((line, idx, arr) => !(line === "" && (idx === 0 || idx === arr.length - 1)))
    .join("\n");

  const content = `/*
 * 自動生成——手で編集しない（GDG デザイン移行 PR1）。
 * \`node packages/web-ui/scripts/generate-gdg-dark-media.mjs\` で作り直す。
 *
 * vendored \`../tokens.css\` の \`.dark { ... }\` ブロックを、
 * \`prefers-color-scheme: dark\` の @media へ複製したもの。
 *
 * \`:root:not(.light)\` にしているのは、将来 \`.light\` クラスで明示的に
 * ライトへ固定したときに、この @media 側の上書きを無効にするため。
 * \`.dark\` クラスによる明示的なダーク固定は、同じ \`gdg-tokens\` レイヤー内の
 * 通常の詳細度・出現順により、この @media の有無に関わらず効き続ける。
 */
@layer gdg-tokens {
  @media (prefers-color-scheme: dark) {
    :root:not(.light) {
${indentedBody}
    }
  }
}
`;

  return { ok: true, varNames, content };
}

/**
 * `.dark` の変数名の集合を、ふつうの TS モジュールとして書き出す
 * （GDG デザイン移行 PR1）。
 *
 * ## なぜ要るのか
 *
 * 各 Worker の `kiwa-stylesheet.test.ts` は、**配信される CSS**（実際に
 * fetch した応答本文）が持つ `@media (prefers-color-scheme: dark)` の
 * 変数名の集合と、`tokens.css` の `.dark` が持つ集合を突き合わせたい。
 * だが Worker のテストは `@cloudflare/vitest-pool-workers`（workerd）の
 * 中で動き、**素の `node:fs` でディスク上の任意のファイルを読めない**
 * ——`readFileSync` で `tokens.css` を直接読もうとすると
 * `ENOENT: no such file or directory` になる（実測済み）。
 *
 * そこで `tokens.css` の中身ではなく、**ビルド時に確定した変数名の配列**
 * を ES モジュールとして書き出し、Worker 側は `@u18/web-ui` から
 * ふつうに import する——モジュールの import 解決は bundler が行うので、
 * workerd のファイルシステム制限を受けない。
 *
 * @param {string[]} varNames
 * @returns {string}
 */
export function buildVarNamesModule(varNames) {
  return `/*
 * 自動生成——手で編集しない（GDG デザイン移行 PR1）。
 * \`node packages/web-ui/scripts/generate-gdg-dark-media.mjs\` で作り直す。
 *
 * vendored \`../gdg/tokens.css\` の \`.dark { ... }\` が宣言する変数名の
 * 集合。各 Worker の \`kiwa-stylesheet.test.ts\` が、配信 CSS の
 * \`@media (prefers-color-scheme: dark)\` と突き合わせるために読む
 * （workerd の中では \`tokens.css\` を直接 \`readFileSync\` できないため）。
 */
export const GDG_DARK_CLASS_VAR_NAMES = ${JSON.stringify(varNames, null, 2)};
`;
}
