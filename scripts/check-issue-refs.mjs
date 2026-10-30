/**
 * 文書が「#N で決める」と指している issue が、まだ open かを確かめる。
 *
 * 拾い方と理由は `lib/issue-refs.mjs`。ここは GitHub へ問い合わせて報告する。
 *
 * **`pnpm lint` には入れない。** 他人が issue を閉じただけで落ちる検査なので、
 * 手元の lint に混ぜると「自分の変更が lint に落ちた」に見える。
 * `check-deadlines.mjs` と同じ独立したジョブに置く（#234 と同じ判断）。
 *
 * ## 射程は `docs/*.md` だけだった（#371 / #429）
 *
 * **このリポジトリはコメントが分厚い。** `apps/**` / `packages/**` の
 * TypeScript コメントと `.github/**` の文書が、丸ごと射程の外にあった。
 *
 * 実際に 1 件あった——`rate-limit-policy.ts` が「#236 で扱う」と書いたまま
 * 残っていたが、**#236 は 2026-10-28 に閉じており、該当する層は
 * `start-email-otp.use-case.ts` に入っていた。** `docs/` だけを見ていた
 * ので、この検査は何も言わなかった（#429 で直した）。
 *
 * `findForwardIssueRefs` 自体は変えていない。射程を広げて 544 ファイルに
 * 当てても、ヒットはこの 1 件だけだった——誤検出がほぼ出ないことの
 * 裏付けでもある。
 */
import { readFileSync, globSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { findForwardIssueRefs } from "./lib/issue-refs.mjs";

/**
 * 参照を拾う対象。**`node_modules` と `.claude/worktrees/`（他セッションの
 * 作業ツリー）は手で除く**——pnpm の `node_modules` は symlink 経由で
 * `**` が踏み込まないことを実測済みだが、`.claude/worktrees/` は通常の
 * ディレクトリなので同じ保証が無い。
 */
const GLOBS = [
  "*.md",
  "docs/**/*.md",
  ".github/**/*.md",
  "apps/**/*.{ts,tsx,mjs,md,jsonc}",
  "packages/**/*.{ts,tsx,mjs,md,jsonc}",
];

const EXCLUDED_PATH_SEGMENTS = ["node_modules", ".claude"];

function isExcluded(file) {
  const segments = file.split("/");
  return EXCLUDED_PATH_SEGMENTS.some((segment) => segments.includes(segment));
}

const seenFiles = new Set();
for (const glob of GLOBS) {
  for (const file of globSync(glob)) {
    if (isExcluded(file)) continue;
    seenFiles.add(relative(process.cwd(), file));
  }
}

// **0 件ガード。** 置き場所が変わって拾えなくなった状態と、対象ファイルが
// 無い状態は、出力からは区別が付かない（#243 と同じ理由。この検査自身が
// `docs/*.md` のみに狭まっていたことに長く気づけなかった反省も踏まえる）。
if (seenFiles.size === 0) {
  console.error(
    `::error::check-issue-refs: ${GLOBS.join(" / ")} のどれにも一致しませんでした。` +
      " 置き場所が変わったなら、このスクリプトの glob も直してください（検査が黙って無効になっています）。",
  );
  process.exit(1);
}

const refs = [...seenFiles].flatMap((file) =>
  findForwardIssueRefs(file, readFileSync(file, "utf8")),
);

if (refs.length === 0) {
  // 0 件そのものは正常でありうる（全部 open で、かつ参照が無い場合）。
  console.log(
    `check-issue-refs: ${seenFiles.size} ファイルを見て、これからのこととして指している issue はありません。`,
  );
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
  `check-issue-refs: ${seenFiles.size} ファイルを見て、${refs.length} 件の参照（${stateOf.size} 個の issue）を見ました。` +
    `閉じているもの: ${closed.length} 件。`,
);

if (closed.length > 0) process.exit(1);
