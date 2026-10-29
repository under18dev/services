/**
 * 文書が「#N で決める」と指している issue が、まだ open かを確かめる。
 *
 * 拾い方と理由は `lib/issue-refs.mjs`。ここは GitHub へ問い合わせて報告する。
 *
 * **`pnpm lint` には入れない。** 他人が issue を閉じただけで落ちる検査なので、
 * 手元の lint に混ぜると「自分の変更が lint に落ちた」に見える。
 * `check-deadlines.mjs` と同じ独立したジョブに置く（#234 と同じ判断）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { findForwardIssueRefs } from "./lib/issue-refs.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const docsDir = path.join(repoRoot, "docs");

const files = readdirSync(docsDir)
  .filter((name) => name.endsWith(".md"))
  .map((name) => path.join("docs", name));

const refs = files.flatMap((file) =>
  findForwardIssueRefs(file, readFileSync(path.join(repoRoot, file), "utf8")),
);

if (refs.length === 0) {
  // 0 件そのものは正常でありうる（全部 open で、かつ参照が無い場合）。
  // ただし「拾い方が壊れて 0 件」と区別できないので、文書が 1 つも
  // 無いときだけ故障として落とす。
  if (files.length === 0) {
    console.error(
      "::error::No docs/*.md found, so no issue reference was checked. This is a bug in the check, not a clean repository.",
    );
    process.exit(1);
  }
  console.log("check-issue-refs: これからのこととして指している issue はありません。");
  process.exit(0);
}

/** 番号ごとに state を 1 回だけ引く。issue でも PR でも同じ endpoint で引ける。 */
const stateOf = new Map();
for (const number of new Set(refs.map((r) => r.number))) {
  try {
    const out = execFileSync(
      "gh",
      ["api", `repos/{owner}/{repo}/issues/${number}`, "--jq", ".state"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    stateOf.set(number, out.trim().toUpperCase());
  } catch (error) {
    // **問い合わせに失敗したら落とす。** 緑のまま通すと、認証が切れた
    // 日から検査が黙る。
    console.error(
      `::error::#${number} の状態を取得できませんでした: ${String(error?.message ?? error).split("\n")[0]}`,
    );
    process.exit(1);
  }
}

const closed = refs.filter((ref) => stateOf.get(ref.number) === "CLOSED");

for (const ref of closed) {
  console.error(
    `::error file=${ref.path},line=${ref.line}::「${ref.text}」が指す #${ref.number} は CLOSED です。` +
      `残件が open の一覧から消えています。新しい issue を立ててそちらを指すか、決着したなら本文を書き換えてください。`,
  );
}

console.log(
  `check-issue-refs: ${refs.length} 件の参照（${stateOf.size} 個の issue）を見ました。` +
    `閉じているもの: ${closed.length} 件。`,
);

if (closed.length > 0) process.exit(1);
