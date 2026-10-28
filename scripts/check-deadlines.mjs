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
  // **踏んだ人は、たいてい無関係な PR を出しただけである。**
  //
  // 期限が来た日から、誰がどんな変更を出しても赤くなる。原因を自分の差分に
  // 探させないために、まず「あなたのせいではない」と「何をすれば緑になるか」
  // を書く。これが伝わらないと、#234 とは逆向きに**赤を消すために期限だけ
  // 伸ばす**が定着する —— それは条件に戻すのと同じことである。
  console.error("");
  console.error("This failure is NOT caused by the change in this pull request.");
  console.error(
    "A deadline recorded in the docs has arrived. It fails on every pull request until the decision is recorded.",
  );
  console.error("");
  console.error("To make it green, do one of these -- in this order of preference:");
  console.error(
    "  1. Record the decision where the deadline points (usually the issue named next to it), then remove the marker.",
  );
  console.error(
    "  2. Move the date out ONLY together with a written reason for the new date, in the same paragraph.",
  );
  console.error(
    "Moving the date with no reason turns it back into the condition it replaced, which nobody monitors (#234).",
  );
  console.error("");

  for (const d of result.passed) {
    console.error(
      `::error file=${d.path},line=${d.line}::Deadline ${d.date} has arrived and the decision is still not recorded: ${d.text}. This is unrelated to your change -- see the job log for what to do.`,
    );
  }
  process.exit(1);
}

console.log("No deadline has arrived yet.");
