#!/usr/bin/env node
/**
 * 追跡されているファイルに生成物が混ざっていないかを見る（#388）。
 *
 * 判定の実体は `lib/tracked-artifacts.mjs` にある。ここは**何を一覧に
 * 取るか**と**どう報告するか**だけを持つ。
 *
 * ## なぜ検査にしたか
 *
 * #388 が `scripts/__pycache__/` を一緒に持ち込み、`.pyc` が 3 つ main に
 * 入った。`.gitignore` に Python の行が 1 つも無く、レビューでも
 * 気づかれなかった —— **生成物は差分の中で「中身の読めない 1 行」**
 * （`Binary files differ`）なので、目が滑る形である。
 *
 * ## `.gitignore` は読まない
 *
 * **`.gitignore` は「まだ追跡していないファイル」しか止めない。** 無視
 * 規則を足しても、既に入ってしまったものは消えない。だからここは
 * `git ls-files` ——**実際に git に入っているもの**——を見る。
 * 2 つが独立していないと、片方だけ直っている状態を見つけられない。
 *
 * ## 作業ツリーではなく index を見る
 *
 * `git ls-files` が返すのは index の中身で、これは**次のコミットに
 * 入るもの**である。CI では HEAD と一致する。手元では
 * `git add` した直後に落ちるので、入る前に気づける。
 *
 * ## 0 件ガード
 *
 * **1 件も見なかったら落とす。** 一覧が取れなかった状態と、全部きれいな
 * 状態は出力からは区別が付かない（`check-shell-exit-status.mjs` と
 * 同じ理由）。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { findTrackedArtifacts, parseLsFiles } from "./lib/tracked-artifacts.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

let stdout;
try {
  // **`-z` で受ける。** 改行を含むファイル名を 2 つに割らないため。
  stdout = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  console.error(
    "::error::check-tracked-artifacts: git ls-files に失敗しました。" +
      ` 追跡されているファイルの一覧が取れないので、検査になりません: ${error.message}`,
  );
  process.exit(1);
}

const tracked = parseLsFiles(stdout);

if (tracked.length === 0) {
  console.error(
    "::error::check-tracked-artifacts: 追跡されているファイルが 1 件も見つかりませんでした。" +
      " git リポジトリの外で動かしていないか確かめてください（検査が黙って無効になっています）。",
  );
  process.exit(1);
}

const findings = findTrackedArtifacts(tracked);

if (findings.length > 0) {
  for (const { path: file, label, hint } of findings) {
    console.error(
      `::error file=${file}::${label} は生成物なのに git に入っています。${hint}` +
        ` 消すには \`git rm -r --cached ${file}\` を実行し、.gitignore にも規則があるか確かめてください。`,
    );
  }
  console.error(
    `\n${findings.length} 件。**.gitignore に足すだけでは消えません** ——` +
      " 既に追跡されているファイルは無視規則の対象外です。" +
      " 詳しい理由は scripts/lib/tracked-artifacts.mjs の冒頭にあります（#388）。",
  );
  process.exit(1);
}

console.log(`check-tracked-artifacts: 追跡されている ${tracked.length} ファイルを見て、問題なし。`);
