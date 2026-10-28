#!/usr/bin/env node
/**
 * 文書に書かれた「決める期限」のうち、過ぎたものがあれば落とす。
 *
 * ## なぜ
 *
 * 残課題を条件（「必要になったら」「#106 が直るまで」）で書くと、**条件を
 * 誰も監視しない。** #234 では、解決済みの issue を指す断り書きが 4 日残り、
 * **その下に足した検査が赤くなっても「既知」で流れる**状態になっていた。
 *
 * 日付で書けば機械が見られる —— ただし**見る者がいなければ同じ**なので、
 * ここが見る。
 *
 * ## 何を落とすか
 *
 * - 期限を過ぎた（当日を含む）ものが 1 つでもあれば **exit 1**
 * - 期限が **1 つも見つからない**場合も exit 1。全部片付いたのか、書き方が
 *   変わって拾えなくなったのか、**出力からは区別できない**ため（#217 の
 *   0 件ガードと同じ判断。脅威モデル §4.5）
 *
 * 使い方: `pnpm check:deadlines`
 */
import { globSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findDeadlines, review } from "./lib/deadlines.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** 探す先。増やすときはここだけ。 */
const PATTERNS = ["docs/**/*.md", "*.md", ".github/**/*.yml", ".github/**/*.md"];

const files = [...new Set(PATTERNS.flatMap((p) => globSync(p, { cwd: root })))].sort();

const deadlines = files.flatMap((file) =>
  findDeadlines(relative(root, resolve(root, file)), readFileSync(resolve(root, file), "utf8")),
);

const today = new Date();
const result = review(deadlines, today);

console.log(`checked ${files.length} files, found ${deadlines.length} deadline(s)`);

if (result.empty) {
  console.error(
    "::error::No deadline markers found. Either every deadline was resolved, or the marker format changed and this check now passes without checking anything. If they are genuinely all resolved, decide explicitly whether to keep this check.",
  );
  process.exit(1);
}

for (const d of result.upcoming) {
  console.log(`  ${d.date}  ${d.path}:${d.line}  ${d.text}`);
}

if (result.passed.length > 0) {
  for (const d of result.passed) {
    console.error(
      `::error file=${d.path},line=${d.line}::Deadline ${d.date} has arrived and the decision is still not recorded: ${d.text}`,
    );
  }
  process.exit(1);
}

console.log("No deadline has arrived yet.");
