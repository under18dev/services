#!/usr/bin/env node
/**
 * `uses:` が 40 桁のコミット SHA に固定されているかを見る（#397）。
 *
 * `.github/workflows/README.md` の「Action はコミット SHA で固定する」が
 * 規則として書いてあるだけで、**破っても CI は通らない状態だった** ——
 * 実際に `actions/checkout@v5` と書いて push し、`pnpm lint` も CI も
 * 通った（#395、2026-10-30）。偶然別の理由で steps を読み直して気づいた。
 *
 * ## なぜ落ちてほしいか
 *
 * タグは動かせる。`actions/checkout@v5` は、作者がタグを付け替えた瞬間に
 * 別のコードになる。1 箇所だけ緩いことは、全部緩いのと同じくらい悪い
 * （攻撃者はその 1 箇所を狙えばよい）。
 *
 * 人のレビューでは見つけにくい —— `uses:` の行は差分の中で 1 行で、
 * 40 桁の 16 進数が並んでいる中に `@v5` が 1 つ混ざっても目が滑る。
 *
 * ## `./` で始まるものは対象外
 *
 * ローカルの composite action には固定すべき外部リビジョンが無い。
 *
 * ## 0 件ガード
 *
 * **1 件も見なかったら落とす。** 置き場所が変わって対象を拾えなくなった
 * 状態と、全部きれいな状態は出力からは区別が付かない
 * （`check-shell-exit-status.mjs` と同じ理由）。
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { relative } from "node:path";

const GLOBS = [".github/workflows/*.yml", ".github/actions/*/action.yml"];

/**
 * `uses:` の行を拾う。**`- uses:` の形が大多数**（steps の配列要素）で、
 * 素の `uses:`（最初の実装が想定していた形）はほぼ無かった ——
 * 最初に書いたとき `(\s*)uses:` だけにして自分で踏んだ。実際にタグへ
 * 差し替えて確かめるまで、1 件も拾えていないことに気づかなかった。
 */
const USES_LINE = /^\s*(?:-\s*)?uses:\s*(\S+)\s*(?:#.*)?$/;

/** @type {{file: string, line: number, value: string}[]} */
const findings = [];
let scanned = 0;

for (const pattern of GLOBS) {
  for (const file of globSync(pattern)) {
    const source = readFileSync(file, "utf8");
    scanned += 1;
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = USES_LINE.exec(lines[i]);
      if (match === null) continue;
      const value = match[1];

      // ローカルの composite action。固定すべき外部リビジョンが無い。
      if (value.startsWith("./")) continue;

      // **知らない形は落とす。** `owner/repo@<40桁SHA>` だけを許可する。
      // 再利用ワークフロー（`owner/repo/.github/workflows/x.yml@ref`）や
      // `docker://` がいま無いのは確かめた（グレップ）。出てきたら
      // この検査が「古い形の集合」になったことに気づけるよう、
      // 素通しにしない。
      if (!/^[^@]+@[0-9a-f]{40}$/.test(value)) {
        findings.push({ file: relative(process.cwd(), file), line: i + 1, value });
      }
    }
  }
}

if (scanned === 0) {
  console.error(
    `::error::check-action-pins: ${GLOBS.join(" / ")} のどれにも一致しませんでした。` +
      " 置き場所が変わったなら、このスクリプトの glob も直してください（検査が黙って無効になっています）。",
  );
  process.exit(1);
}

if (findings.length > 0) {
  for (const { file, line, value } of findings) {
    console.error(
      `::error file=${file},line=${line}::\`uses: ${value}\` が 40 桁のコミット SHA に` +
        " 固定されていません。タグは動かせるので、作者がタグを付け替えた瞬間に" +
        " 別のコードを実行することになります。`uses: owner/repo@<40桁SHA> # vX.Y.Z` の形にしてください。",
    );
  }
  console.error(
    `\n${findings.length} 件。詳しい理由は .github/workflows/README.md の` +
      " 「Action はコミット SHA で固定する」を参照してください。",
  );
  process.exit(1);
}

console.log(`check-action-pins: ${scanned} ファイルを見て、問題なし。`);
