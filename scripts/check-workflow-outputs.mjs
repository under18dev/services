#!/usr/bin/env node
/**
 * `needs.<job>.outputs.<name>` の参照が、実在するジョブ・実在する
 * output を指しているかを見る（#403）。
 *
 * ## 何が起きたか
 *
 * #395 で `needs.preflight.outputs.should_deploy` と書いたが、
 * `preflight` が宣言している output は `ready` だけだった。**存在しない
 * output への参照は空文字になる**ので `== 'true'` は常に false —— 2 つの
 * ジョブが一度も走らず、**run は緑のまま**だった（スキップは失敗ではない）。
 *
 * YAML としても GitHub Actions としてもエラーにならない。この形の
 * タイポは静的には止まらない。
 *
 * ## 完全な YAML パーサは使わない
 *
 * このリポジトリに YAML パーサの依存が無く、`check-shell-exit-status.mjs`
 * も独自の正規表現でブロックを切り出している。prettier が揃えた
 * 2 スペース刻みのインデントを前提にした、同じ形の素朴な走査にする。
 *
 * ## 0 件ガード
 *
 * **参照を 1 つも見なかったら落とす。** `needs.*.outputs.*` という形が
 * もう使われなくなった状態と、全部正しい状態は出力からは区別が付かない。
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { relative } from "node:path";

const WORKFLOW_GLOB = ".github/workflows/*.yml";

/** ジョブ名（`  job-name:`、2 スペース、`jobs:` の直下）。 */
const JOB_LINE = /^  ([A-Za-z0-9_-]+):\s*$/;
/** output の宣言（`      name:`、6 スペース、`outputs:` の下）。 */
const OUTPUT_LINE = /^      ([A-Za-z0-9_-]+):/;
/** 参照。`needs.X.result` のような組み込みは `.outputs.` を挟まないので対象外。 */
const REF = /needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g;

/**
 * 1 ファイル分のジョブ → 宣言済み output 名の集合、を読む。
 *
 * **`jobs:` より前は見ない。** `on.workflow_dispatch.inputs` なども
 * 2 スペースのキーを持つので、`jobs:` の行を境に区切らないと誤って
 * ジョブとして拾う。
 */
function readJobOutputs(lines) {
  const jobsStart = lines.findIndex((l) => l === "jobs:");
  if (jobsStart === -1) return new Map();

  /** @type {Map<string, Set<string>>} */
  const jobs = new Map();
  let currentJob = null;
  let inOutputsBlock = false;

  for (let i = jobsStart + 1; i < lines.length; i++) {
    const line = lines[i];

    const jobMatch = JOB_LINE.exec(line);
    if (jobMatch !== null) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, new Set());
      inOutputsBlock = false;
      continue;
    }

    if (currentJob === null) continue;

    if (line === "    outputs:") {
      inOutputsBlock = true;
      continue;
    }

    if (inOutputsBlock) {
      const outMatch = OUTPUT_LINE.exec(line);
      if (outMatch !== null) {
        jobs.get(currentJob).add(outMatch[1]);
        continue;
      }
      // インデントが 6 スペース未満に戻ったら outputs ブロックを抜ける。
      // 空行・コメント行では抜けない（prettier は outputs の内側にも
      // 空行を入れないが、将来のための保険）。
      if (line.trim() !== "" && !/^      /.test(line)) inOutputsBlock = false;
    }
  }

  return jobs;
}

/** @type {{file: string, line: number, job: string, name: string, reason: string}[]} */
const findings = [];
let refsSeen = 0;

for (const file of globSync(WORKFLOW_GLOB)) {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  const jobs = readJobOutputs(lines);
  const relPath = relative(process.cwd(), file);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue; // コメント行は見ない

    for (const match of line.matchAll(REF)) {
      refsSeen += 1;
      const [, job, name] = match;

      if (!jobs.has(job)) {
        findings.push({
          file: relPath,
          line: i + 1,
          job,
          name,
          reason: `ジョブ \`${job}\` がこのワークフローに無い`,
        });
        continue;
      }
      if (!jobs.get(job).has(name)) {
        const declared = [...jobs.get(job)];
        findings.push({
          file: relPath,
          line: i + 1,
          job,
          name,
          reason:
            declared.length === 0
              ? `ジョブ \`${job}\` は outputs を 1 つも宣言していない`
              : `ジョブ \`${job}\` が宣言している output は ${declared.map((d) => `\`${d}\``).join(", ")} だけ`,
        });
      }
    }
  }
}

if (refsSeen === 0) {
  console.error(
    `::error::check-workflow-outputs: ${WORKFLOW_GLOB} のどこにも` +
      " \`needs.<job>.outputs.<name>\` の参照が見つかりませんでした。" +
      " 形が変わったなら、このスクリプトの正規表現も直してください（検査が黙って無効になっています）。",
  );
  process.exit(1);
}

if (findings.length > 0) {
  for (const { file, line, job, name, reason } of findings) {
    console.error(
      `::error file=${file},line=${line}::\`needs.${job}.outputs.${name}\` は参照先が無い` +
        `（${reason}）。存在しない output への参照は空文字になるので、` +
        " \`== 'true'\` のような比較は常に false になります。ジョブは走らずスキップされ、" +
        " run 自体は緑のままです（#403 で実際に 2 ジョブがこれで一度も走っていませんでした）。",
    );
  }
  console.error(`\n${findings.length} 件。詳しい理由はこのスクリプトの冒頭を参照してください。`);
  process.exit(1);
}

console.log(`check-workflow-outputs: ${refsSeen} 件の参照を見て、問題なし。`);
