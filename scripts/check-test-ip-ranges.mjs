#!/usr/bin/env node
/**
 * テストが名乗る IP の割り当てが、**実際の直書きと重なっていない**こと。
 *
 * ## なぜ手書きの一覧ではだめなのか
 *
 * 最初は「固定アドレスを使っているファイル」をテスト側に手で並べていた。
 * **その一覧が `203.0.113.1` を落としていた** —— 4 つのファイルが直書き
 * しているのに、検査は 2 つしか見ていなかった。`freshIpFactory("rate-limit")`
 * が最初に配るのがまさに `203.0.113.1` なので、**検査の題（「固定アドレスと
 * 重ならない」）と中身が食い違っていた。**
 *
 * 手書きの一覧は実態と結ばれていないと必ずずれる。今日ランブック §13.2 の
 * 「別のファイルでは気をつけて」が 3 回守られなかったのと同じ形なので、
 * **並べるのをやめて、実際のファイルから拾う。**
 *
 * ## 何を落とすか
 *
 * `freshIpFactory` が配る範囲に入るアドレスが、テストのどこかに直接
 * 書かれていたら落とす。いま壊れていなくても（直書きの 4 箇所は
 * `CF-Connecting-IP` として送っていない）、**次に誰かがそれを
 * ヘッダへ載せた瞬間に枠を食い合う。** そしてその落ち方は実行の速さに
 * 依存するので、手元では再現しない。
 *
 * ## なぜ vitest ではなくここなのか
 *
 * auth-worker のテストは workerd 上で走るので `node:fs` が無い。
 * ファイルを横断して読む検査は Node 側に置くしかない。
 */
import { readFileSync, globSync } from "node:fs";
import { relative } from "node:path";

const RANGES_FILE = "apps/auth-worker/test/fresh-ip.ts";
const TEST_GLOBS = ["apps/*/test/**/*.ts", "apps/*/test/**/*.tsx", "packages/*/test/**/*.ts"];

/** `"203.0.113.1"` のような完全な 4 オクテットだけを拾う。 */
const ADDRESS = /"(192\.0\.2|198\.51\.100|203\.0\.113)\.(\d{1,3})"/g;

/** `fresh-ip.ts` の `RANGES` を読む。TS をパースせず形だけ見る。 */
function readRanges(source) {
  const entries = [];
  const pattern = /"([a-z-]+)":\s*\{\s*prefix:\s*"([\d.]+)",\s*from:\s*(\d+),\s*to:\s*(\d+)\s*\}/g;
  for (const m of source.matchAll(pattern)) {
    entries.push({ scope: m[1], prefix: m[2], from: Number(m[3]), to: Number(m[4]) });
  }
  return entries;
}

/**
 * **`fixed-values` は配らない範囲なので対象外。** あそこは直書きのために
 * 空けてあり、そこに直書きがあるのは正しい状態である。
 */
const RESERVED_FOR_FIXED = "fixed-values";

const allRanges = readRanges(readFileSync(RANGES_FILE, "utf8"));
const ranges = allRanges.filter((r) => r.scope !== RESERVED_FOR_FIXED);

// **予約そのものが消えていたら落とす。** 無くなると直書きが巡回の
// 範囲に入りうるが、この検査は「範囲に入っていない」としか言わないので
// 気づけない。
if (!allRanges.some((r) => r.scope === RESERVED_FOR_FIXED)) {
  console.error(
    `::error::check-test-ip-ranges: ${RANGES_FILE} に "${RESERVED_FOR_FIXED}" がありません。` +
      " 直書き用に空けてある範囲が消えると、巡回がそこへ踏み込みます。",
  );
  process.exit(1);
}

// **0 件ガード。** 書き方を変えて拾えなくなった状態と、重なりが無い状態は
// 出力から区別が付かない（#243 と同じ理由）。
if (allRanges.length === 0) {
  console.error(
    `::error::check-test-ip-ranges: ${RANGES_FILE} から RANGES を 1 件も読めませんでした。` +
      " 書き方を変えたなら、このスクリプトの正規表現も直してください（検査が黙って無効になっています）。",
  );
  process.exit(1);
}

const findings = [];
let scanned = 0;

for (const glob of TEST_GLOBS) {
  for (const file of globSync(glob)) {
    // 割り当て表そのものと、それを検査するファイルは対象外。
    if (file.endsWith("fresh-ip.ts")) continue;
    scanned += 1;

    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");

    for (const [index, line] of lines.entries()) {
      for (const m of line.matchAll(ADDRESS)) {
        const address = `${m[1]}.${m[2]}`;
        const octet = Number(m[2]);
        const owner = ranges.find((r) => r.prefix === m[1] && octet >= r.from && octet <= r.to);
        if (owner !== undefined) {
          findings.push({
            file: relative(process.cwd(), file),
            line: index + 1,
            address,
            scope: owner.scope,
          });
        }
      }
    }
  }
}

if (scanned === 0) {
  console.error(
    `::error::check-test-ip-ranges: ${TEST_GLOBS.join(" / ")} のどれにも一致しませんでした。` +
      " 置き場所が変わったなら glob も直してください（検査が黙って無効になっています）。",
  );
  process.exit(1);
}

if (findings.length > 0) {
  for (const { file, line, address, scope } of findings) {
    console.error(
      `::error file=${file},line=${line}::${address} は freshIpFactory("${scope}") が配る範囲にあります。` +
        " いま壊れていなくても、この値を CF-Connecting-IP に載せた瞬間に枠を食い合います。" +
        " apps/auth-worker/test/fresh-ip.ts の範囲を動かすか、この直書きをやめてください。",
    );
  }
  console.error(`\n${findings.length} 件。割り当ては ${RANGES_FILE} にあります。`);
  process.exit(1);
}

console.log(
  `check-test-ip-ranges: ${scanned} ファイルを見て、${ranges.length} 個の範囲と重なる直書きはありませんでした。`,
);
