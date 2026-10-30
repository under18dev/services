#!/usr/bin/env node
/**
 * `docs/threat-model.md` の ID（`T-1` / `N-5` / `RR-21` のような）への
 * 参照が、実在する ID を指しているかを確かめる（#371）。
 *
 * 判定の実体は `lib/threat-model-refs.mjs` にある。ここは**どのファイルを
 * 見るか**と**どう報告するか**だけを持つ。
 *
 * ## なぜ検査にしたか
 *
 * #371 が数えた「2026-10-29 夜〜30 朝に見つかった記述の食い違い」の中に、
 * **存在しない番号への参照が 12 箇所**あった（`RR-21`）。番号は削除・
 * 統合・採番し直しで変わりうるが、**参照している側は自分では気づけない**
 * ——コードの識別子と違い、`git grep` で引いても「文字列としては一致する」
 * ので、人が番号を数えて突き合わせない限り見つからない。
 *
 * ## 何を見ないか
 *
 * **`RR-21` の中身が最新かは見ない。** 「この説明は実装と合っているか」は
 * 一般には判定できない（#371 の結論）。ここで見るのは**番号が実在するか**
 * だけ——`#364`（文書が言う定数と実装の値の突き合わせ）とは別の軸。
 */
import { readFileSync, globSync } from "node:fs";
import { relative } from "node:path";
import { findReferences, parseDefinedIds } from "./lib/threat-model-refs.mjs";

const THREAT_MODEL_PATH = "docs/threat-model.md";

/**
 * 参照を拾う対象。**`docs/threat-model.md` 自身も含む** —— 「RR-19 の補足」
 * のような地の文の言及が、本体の番号と食い違っていないかも同じ理由で崩れる。
 *
 * node_modules はどの glob にも含まれない（`apps/*` / `packages/*` の
 * 直下だけを辿るため、インストール先の `node_modules/@u18/...` のような
 * 階層まで降りない）。
 */
const GLOBS = [
  "*.md",
  "docs/**/*.md",
  ".github/**/*.md",
  "apps/*/*.md",
  "apps/*/*.jsonc",
  "apps/*/src/**/*.{ts,tsx}",
  "apps/*/test/**/*.{ts,tsx}",
  "apps/*/scripts/**/*.mjs",
  "packages/*/*.md",
  "packages/*/src/**/*.ts",
  "scripts/**/*.mjs",
];

const threatModelSource = readFileSync(THREAT_MODEL_PATH, "utf8");
const defined = parseDefinedIds(threatModelSource);

// **0 件ガード。** 見出し・表の書き方を変えて拾えなくなった状態と、
// ID が 1 つも無い状態は、出力からは区別が付かない（#243 と同じ理由）。
if (defined.size === 0) {
  console.error(
    `::error::check-threat-model-refs: ${THREAT_MODEL_PATH} から ID を 1 件も読めませんでした。` +
      " 見出し（#### T-1：...）や表（| RR-1 | ...）の書き方を変えたなら、" +
      " scripts/lib/threat-model-refs.mjs のパターンも直してください（検査が黙って無効になっています）。",
  );
  process.exit(1);
}

/**
 * **自分のテスト用の作り物の ID は見ない。** `threat-model-refs.test.mjs` は
 * 「2 文字の接頭辞を 1 文字の接頭辞として誤読しないか」を確かめるために、
 * **わざと実在しない ID** を期待値として書いている。そのまま拾うと、
 * 自分自身の正しいテストを「壊れた参照」として報告してしまう
 * （`check-test-ip-ranges.mjs` が自分の `fresh-ip.ts` を除外するのと同じ理由）。
 */
const SELF_TEST_FIXTURE = "scripts/lib/threat-model-refs.test.mjs";

const seenFiles = new Set();
const findings = [];

for (const glob of GLOBS) {
  for (const file of globSync(glob)) {
    if (seenFiles.has(file)) continue; // 複数の glob が同じファイルを拾いうる。
    seenFiles.add(file);
    if (relative(process.cwd(), file) === SELF_TEST_FIXTURE) continue;

    const source = readFileSync(file, "utf8");
    for (const ref of findReferences(relative(process.cwd(), file), source)) {
      if (!defined.has(ref.id)) findings.push(ref);
    }
  }
}

if (seenFiles.size === 0) {
  console.error(
    `::error::check-threat-model-refs: ${GLOBS.join(" / ")} のどれにも一致しませんでした。` +
      " 置き場所が変わったなら、このスクリプトの glob も直してください（検査が黙って無効になっています）。",
  );
  process.exit(1);
}

if (findings.length > 0) {
  for (const { file, line, id, text } of findings) {
    console.error(
      `::error file=${file},line=${line}::「${id}」は ${THREAT_MODEL_PATH} に実在しません。` +
        " 番号が変わった・統合された・削除されたなら、この参照も書き直してください。",
    );
    console.error(`  ${file}:${line}  ${text}`);
  }
  console.error(
    `\n${findings.length} 件。全 ${defined.size} 個の ID のどれにも一致しませんでした。`,
  );
  process.exit(1);
}

console.log(
  `check-threat-model-refs: ${seenFiles.size} ファイルを見て、${defined.size} 個の ID、問題なし。`,
);
