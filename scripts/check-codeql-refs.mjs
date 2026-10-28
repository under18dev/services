#!/usr/bin/env node
/**
 * `github/codeql-action` の参照が全部同じコミットを指していること。
 *
 * `init` と `analyze` はバージョンが揃っていなければならない。Dependabot
 * 側は #71 でグループ化したので割れた PR は作られないが、**手で編集して
 * ずらすことは依然できる。**
 *
 * ## なぜ実行ではなく静的に見るのか
 *
 * **そのズレは CI からは見えない。** CodeQL ジョブは public リポジトリで
 * のみ実行される（#26）ので、private の間は壊れた組み合わせでも何の信号も
 * 出ず、public 化した日に初めて露見する。
 *
 * ## ci.yml の inline shell から移した（#219）
 *
 * 手元から `pnpm check` で CI と同じものを回せるようにするため。
 * inline のままだと、**手元に入口が無い検査**が 1 つ残る。
 */
import { readFileSync, globSync } from "node:fs";

const PATTERN = /github\/codeql-action\/[a-zA-Z0-9_-]*@[0-9a-f]{40}/g;
const GLOBS = [".github/workflows/*.yml", ".github/actions/*/*.yml"];

/** @type {{file: string, ref: string}[]} */
const refs = [];
let scanned = 0;

for (const glob of GLOBS) {
  for (const file of globSync(glob)) {
    scanned += 1;
    for (const ref of readFileSync(file, "utf8").matchAll(PATTERN)) {
      refs.push({ file, ref: ref[0] });
    }
  }
}

// **走査対象が 0 件なら落とす。** 置き場所が変わって拾えなくなった状態と、
// 参照が 1 つも無い状態は、出力からは区別が付かない。区別が付かない検査は、
// 黙って無効になったときに誰も気づけない（#243 と同じ理由）。
if (scanned === 0) {
  console.error(
    `::error::check-codeql-refs: ${GLOBS.join(" と ")} のどちらにも一致しませんでした。` +
      " 置き場所が変わったなら、このスクリプトの glob も直してください（検査が黙って無効になっています）。",
  );
  process.exit(1);
}

if (refs.length === 0) {
  console.log("codeql-action の参照はありません。");
  process.exit(0);
}

for (const { file, ref } of refs) console.log(`  ${file}: ${ref}`);

const commits = new Set(refs.map(({ ref }) => ref.split("@")[1]));
if (commits.size !== 1) {
  console.error(
    `::error::github/codeql-action の参照が ${commits.size} 個の別々のコミットを指しています。` +
      " init と analyze は同じバージョンでなければなりません。" +
      " このズレは CI から見えません —— CodeQL ジョブは public リポジトリでのみ実行されるためです（#26）。",
  );
  process.exit(1);
}

console.log(`check-codeql-refs: ${refs.length} 件、すべて同じコミットを指しています。`);
