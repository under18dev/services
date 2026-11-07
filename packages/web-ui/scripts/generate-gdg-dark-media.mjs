#!/usr/bin/env node
// @ts-check

/**
 * `src/gdg/generated/dark-media.css` を書き出す（GDG デザイン移行 PR1）。
 * 判定の実体は `./lib/gdg-dark-media.mjs` にある。
 *
 * `--check` を付けると書き出さず、既存の生成物が最新かどうかだけを見る
 * （CI 用、ルートの `generate-asset-probe-pages.mjs --check` と同じ形）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildDarkMedia } from "./lib/gdg-dark-media.mjs";

const TOKENS_CSS = join(import.meta.dirname, "..", "src", "gdg", "tokens.css");
const OUTPUT = join(import.meta.dirname, "..", "src", "gdg", "generated", "dark-media.css");
const checkOnly = process.argv.includes("--check");

const tokensCssText = readFileSync(TOKENS_CSS, "utf8");
const result = buildDarkMedia(tokensCssText);

if (!result.ok) {
  for (const error of result.errors) console.error(`::error::${error}`);
  process.exit(1);
}

console.log(`gdg-dark-media: ${result.varNames.length} 個の変数を複製しました。`);

if (checkOnly) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : null;
  if (current !== result.content) {
    console.error(
      "::error::src/gdg/generated/dark-media.css が古いか存在しません。" +
        "`node packages/web-ui/scripts/generate-gdg-dark-media.mjs` を実行してコミットしてください。",
    );
    process.exit(1);
  }
  console.log("generate-gdg-dark-media: src/gdg/generated/dark-media.css は最新です。");
} else {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, result.content, "utf8");
  console.log(`書き出しました: ${OUTPUT}`);
}
