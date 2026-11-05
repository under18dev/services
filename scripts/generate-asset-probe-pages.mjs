#!/usr/bin/env node
// @ts-check

/**
 * `scripts/generated/asset-probe-pages.sh` を書き出す（#453）。
 * 判定の実体は `scripts/lib/generate-asset-probe-pages.mjs` にある。
 *
 * `--check` を付けると書き出さず、既存の生成物が最新かどうかだけを見る
 * （CI 用、各 Worker の worker-configuration.d.ts の drift チェックと同じ形）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { collect, UNPROBEABLE } from "./lib/asset-probe-pages.mjs";
import { buildProbePagesScript } from "./lib/generate-asset-probe-pages.mjs";

const OUTPUT = join(import.meta.dirname, "generated", "asset-probe-pages.sh");
const checkOnly = process.argv.includes("--check");

const { workers } = collect();
const result = buildProbePagesScript(workers, UNPROBEABLE);

for (const note of result.notes) console.log(`  ${note}`);

if (!result.ok) {
  for (const error of result.errors) console.error(`::error::${error}`);
  process.exit(1);
}

if (checkOnly) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : null;
  if (current !== result.content) {
    console.error(
      "::error::scripts/generated/asset-probe-pages.sh が古いか存在しません。" +
        "`node scripts/generate-asset-probe-pages.mjs` を実行してコミットしてください。",
    );
    process.exit(1);
  }
  console.log("generate-asset-probe-pages: scripts/generated/asset-probe-pages.sh は最新です。");
} else {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, result.content, "utf8");
  console.log(`書き出しました: ${OUTPUT}`);
}
