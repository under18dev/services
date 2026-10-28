#!/usr/bin/env node
/**
 * `set -e` の下で、一致ゼロの `grep` を変数に取る形を落とす（#231）。
 *
 * 判定の実体は `lib/shell-exit-status.mjs` にある。ここは**どのファイルを
 * 見るか**と**どう報告するか**だけを持つ。
 *
 * ## なぜ検査にしたか
 *
 * **3 回入ったから。** 2 回は私が書いた。レビューでも気づかれていない
 * （#227 のものは 3 セッションが読んで、誰も言わなかった）。
 * 「気をつける」では止まらないことが分かっている形である。
 *
 * ## 0 件ガード
 *
 * **1 件も見なかったら落とす。** 置き場所が変わって対象が拾えなくなった
 * 状態と、全部きれいな状態は、出力からは区別が付かない。区別が付かない
 * 検査は、黙って無効になったときに誰も気づけない。
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { relative } from "node:path";
import {
  enablesErrExit,
  extractRunBlocks,
  findUnguardedAssignments,
} from "./lib/shell-exit-status.mjs";

const SHELL_GLOB = "scripts/**/*.sh";
const WORKFLOW_GLOB = ".github/workflows/*.yml";

/** @type {{file: string, line: number, name: string, text: string}[]} */
const findings = [];
let scanned = 0;

for (const file of globSync(SHELL_GLOB)) {
  const source = readFileSync(file, "utf8");
  scanned += 1;
  // `set -e` を使っていないスクリプトでは、この形は落ちない。
  if (!enablesErrExit(source)) continue;
  for (const found of findUnguardedAssignments(source)) {
    findings.push({ file: relative(process.cwd(), file), ...found });
  }
}

for (const file of globSync(WORKFLOW_GLOB)) {
  const source = readFileSync(file, "utf8");
  scanned += 1;
  // **ワークフローでは `set -e` の有無を見ない。** GitHub Actions の
  // 既定のシェルは `bash -e` なので、書いていなくても有効である。
  // **ブロックごとに渡す。** 行ごとに切ると、継続行にある `|| true` が
  // 見えずに誤検知する（この検査の最初の実行で実際に踏んだ）。
  for (const { startLine, text } of extractRunBlocks(source)) {
    for (const found of findUnguardedAssignments(text)) {
      findings.push({
        file: relative(process.cwd(), file),
        ...found,
        line: startLine + found.line - 1,
      });
    }
  }
}

if (scanned === 0) {
  console.error(
    `::error::check-shell-exit-status: ${SHELL_GLOB} と ${WORKFLOW_GLOB} のどちらにも一致しませんでした。` +
      " 置き場所が変わったなら、このスクリプトの glob も直してください（検査が黙って無効になっています）。",
  );
  process.exit(1);
}

if (findings.length > 0) {
  for (const { file, line, name, text } of findings) {
    console.error(
      `::error file=${file},line=${line}::\`${name}\` は一致ゼロの grep で落ちます。` +
        " set -e の下では代入ごとスクリプトが終わるので、この下に書いた ::error:: は出ません。" +
        " 末尾に `|| true` を付けるか、grep の終了コードを使いたいなら `if` の条件に置いてください。",
    );
    console.error(`  ${file}:${line}  ${text}`);
  }
  console.error(
    `\n${findings.length} 件。` +
      " 詳しい理由は scripts/lib/shell-exit-status.mjs の冒頭にあります（このリポジトリで 3 回起きています）。",
  );
  process.exit(1);
}

console.log(`check-shell-exit-status: ${scanned} ファイルを見て、問題なし。`);
