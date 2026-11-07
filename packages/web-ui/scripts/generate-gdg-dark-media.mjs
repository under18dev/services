#!/usr/bin/env node
// @ts-check

/**
 * `src/gdg/generated/dark-media.css` と `dark-media-var-names.ts` を
 * 書き出す（GDG デザイン移行 PR1）。判定の実体は `./lib/gdg-dark-media.mjs`
 * にある。
 *
 * **2 本目（`dark-media-var-names.ts`）が要る理由。** 各 Worker の
 * `kiwa-stylesheet.test.ts` は、配信 CSS の `@media (prefers-color-scheme:
 * dark)` と `tokens.css` の `.dark` の変数名の集合を突き合わせたいが、
 * Worker のテストは workerd の中で動き、素の `readFileSync` で
 * `tokens.css` を直接読めない（実測済み）。ビルド時に確定した配列を
 * ふつうの TS モジュールとして書き出し、Worker 側はそれを import する。
 *
 * `--check` を付けると書き出さず、既存の生成物が最新かどうかだけを見る
 * （CI 用、ルートの `generate-asset-probe-pages.mjs --check` と同じ形）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildDarkMedia, buildVarNamesModule } from "./lib/gdg-dark-media.mjs";

const TOKENS_CSS = join(import.meta.dirname, "..", "src", "gdg", "tokens.css");
const CSS_OUTPUT = join(import.meta.dirname, "..", "src", "gdg", "generated", "dark-media.css");
const TS_OUTPUT = join(
  import.meta.dirname,
  "..",
  "src",
  "gdg",
  "generated",
  "dark-media-var-names.ts",
);
const checkOnly = process.argv.includes("--check");

const tokensCssText = readFileSync(TOKENS_CSS, "utf8");
const result = buildDarkMedia(tokensCssText);

if (!result.ok) {
  for (const error of result.errors) console.error(`::error::${error}`);
  process.exit(1);
}

console.log(`gdg-dark-media: ${result.varNames.length} 個の変数を複製しました。`);

const tsContent = buildVarNamesModule(result.varNames);

if (checkOnly) {
  const currentCss = existsSync(CSS_OUTPUT) ? readFileSync(CSS_OUTPUT, "utf8") : null;
  const currentTs = existsSync(TS_OUTPUT) ? readFileSync(TS_OUTPUT, "utf8") : null;
  const errors = [];
  if (currentCss !== result.content) {
    errors.push(
      "src/gdg/generated/dark-media.css が古いか存在しません。" +
        "`node packages/web-ui/scripts/generate-gdg-dark-media.mjs` を実行してコミットしてください。",
    );
  }
  if (currentTs !== tsContent) {
    errors.push(
      "src/gdg/generated/dark-media-var-names.ts が古いか存在しません。" +
        "`node packages/web-ui/scripts/generate-gdg-dark-media.mjs` を実行してコミットしてください。",
    );
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exit(1);
  }
  console.log("generate-gdg-dark-media: 生成物は 2 つとも最新です。");
} else {
  mkdirSync(dirname(CSS_OUTPUT), { recursive: true });
  writeFileSync(CSS_OUTPUT, result.content, "utf8");
  writeFileSync(TS_OUTPUT, tsContent, "utf8");
  console.log(`書き出しました: ${CSS_OUTPUT}`);
  console.log(`書き出しました: ${TS_OUTPUT}`);
}
