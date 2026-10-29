#!/usr/bin/env node
// @ts-check

/**
 * `smoke-asset-probe.sh` が、ハッシュ付きアセットを配る Worker を
 * 取りこぼしていないか確かめる。判定の実体と理由は
 * `scripts/lib/asset-probe-pages.mjs` にある。
 */

import { check, collect } from "./lib/asset-probe-pages.mjs";

const { probeText, deployText, workers } = collect();
const result = check({ probeText, workers, deployText });

const withAssets = workers.filter((w) => w.assets.length > 0);
console.log(
  `check-asset-probe-pages: アセットを配る Worker ${withAssets.length} 個、` +
    `宣言 ${Object.keys(result.declared).length} 件を突き合わせました。`,
);

if (!result.ok) {
  for (const problem of result.problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const skipped = workers.filter((w) => w.assets.length > 0 && !w.hasInventory);
if (skipped.length > 0) {
  console.log(`  （route-inventory を持たない Worker: ${skipped.map((w) => w.name).join(", ")}）`);
}
console.log("  問題なし。");
