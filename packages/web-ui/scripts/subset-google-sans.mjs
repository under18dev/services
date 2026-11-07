// @ts-check
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import prettier from "prettier";
import subsetFont from "subset-font";

/**
 * Google Sans を u18 向けにサブセットする（design-system 連携、GDG の
 * `gdg-jp/design-system` から vendor した `GoogleSans.woff2` が元）。
 *
 * ## なぜサブセットするのか
 *
 * vendor 元は 1,584,340 バイト——多くのスクリプトをカバーする可変フォント
 * だが、u18 の画面は和文が主で、Google Sans が受け持つのは英数字・ID・
 * 日時・件数だけ（和文は Hiragino Sans 等へフォールバックする設計）。残りの
 * スクリプトは、isolate の起動のたびに base64 文字列がパースされるだけの
 * コストになる。
 *
 * ## このスクリプトは `build-client.mjs` と違い、毎回は走らない
 *
 * `assets/fonts/GoogleSans.woff2`（vendor 元・無改変）も
 * `assets/fonts/GoogleSans.subset.woff2`（このスクリプトの出力）も
 * `src/generated/google-sans-font.ts`（同じ出力を base64 にした TS）も、
 * 3 つとも git にコミットする。元ファイルを手で差し替えたときだけ
 * `pnpm --filter @u18/web-ui run build:font` を再実行すること。
 * `test/google-sans-font.test.ts` が 3 ファイルの SHA-256 を固定しているので、
 * 1 つだけ更新するとそこが落ちる。
 *
 * ## 何を残し、何を削るか
 *
 * - **文字**: ASCII 全体・Latin-1 補助・一般約物（em/en dash・カーリー
 *   クォート・三点リーダ等）・通貨記号・矢印・マイナス記号。
 *   `@fontsource-variable/google-sans` が配る公式の Latin サブセット
 *   （`latin-wght-normal`）と同じ unicode-range を踏襲している。和文グリフは
 *   含めない。
 * - **`wght` 軸は可変のまま残す**（400–700）。GDG の
 *   `--gdg-weight-heading: 650` のような中間値を描画できなくなるので、
 *   静的ウェイトに固定してはいけない。
 * - **`opsz` と `GRAD` は固定して削る**（u18 では使わない軸）。
 *
 * 実測（2026-11 時点）: 1,584,340 バイト -> 43,180 バイト（97.3% 減）。
 *
 * 調査段階の見積もり（32〜36KB）より大きい。**正確な原因は未確認**だが、
 * 見積もりは `@fontsource-variable/google-sans` が事前に Latin だけへ
 * 分割済みのファイル（70,752 バイト）を元にしていた一方、vendor 元の
 * `GoogleSans.woff2` は 1 本に多くのスクリプトを収めた可変フォント
 * （3,749 グリフ）で、GSUB/GPOS/cmap 等がスクリプトをまたいで共有
 * されている。グリフ自体は閉じられても、こうした共有テーブルの構造が
 * 単一スクリプト用に最初から作られたファイルほどは小さくならない、
 * というのが現時点での推測。
 */

const root = join(import.meta.dirname, "..");
const SOURCE_PATH = join(root, "assets/fonts/GoogleSans.woff2");
const OUTPUT_WOFF2_PATH = join(root, "assets/fonts/GoogleSans.subset.woff2");
const OUTPUT_MODULE_PATH = join(root, "src/generated/google-sans-font.ts");

/**
 * 残す文字のコードポイント範囲。
 *
 * `@fontsource-variable/google-sans@5.3.2` の `latin-wght-normal`
 * （`files/google-sans-latin-wght-normal.woff2` の `unicode-range`）と
 * 同じ範囲を直接書き写している——u18 では英数字・ID・日時・件数にしか
 * 出てこないので、この範囲で足りる。
 *
 * **`@type` で固定長 2 のタプルとして宣言する。** 書かないと各要素が
 * ただの `number[]` に推論され、`[lo, hi]` の分割代入が
 * `number | undefined` になる（#535）。ここはサブセット範囲そのものを
 * 決めている箇所なので、誤って 3 要素以上の行を足したときに検査で
 * 気づけることが要る——`number[]` のままだと、何要素でも黙って通る。
 */
/** @type {ReadonlyArray<readonly [number, number]>} */
const CODEPOINT_RANGES = [
  [0x0000, 0x00ff],
  [0x0131, 0x0131],
  [0x0152, 0x0153],
  [0x02bb, 0x02bc],
  [0x02c6, 0x02c6],
  [0x02da, 0x02da],
  [0x02dc, 0x02dc],
  [0x0304, 0x0304],
  [0x0308, 0x0308],
  [0x0329, 0x0329],
  [0x2000, 0x206f],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2191, 0x2191],
  [0x2193, 0x2193],
  [0x2212, 0x2212],
  [0x2215, 0x2215],
  [0xfeff, 0xfeff],
  [0xfffd, 0xfffd],
];

function subsetText() {
  let text = "";
  for (const [lo, hi] of CODEPOINT_RANGES) {
    for (let cp = lo; cp <= hi; cp += 1) text += String.fromCodePoint(cp);
  }
  return text;
}

/** @param {Buffer} buffer */
function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const banner =
  "// 生成物。手で編集しない。packages/web-ui/scripts/subset-google-sans.mjs が作る。\n" +
  "// 元ファイルは assets/fonts/GoogleSans.woff2（vendor 元、同じく git にコミットしてある）。\n";

const source = await readFile(SOURCE_PATH);
const subset = await subsetFont(source, subsetText(), {
  targetFormat: "woff2",
  // `wght` はここに書かない = 可変のまま残す。opsz と GRAD だけ固定する。
  variationAxes: {
    opsz: 18,
    GRAD: 0,
  },
});

await writeFile(OUTPUT_WOFF2_PATH, subset);

const base64 = subset.toString("base64");
const moduleSource = await prettier.format(
  `${banner}export const GOOGLE_SANS_FONT_BASE64 = ${JSON.stringify(base64)};\n`,
  { ...(await prettier.resolveConfig(OUTPUT_MODULE_PATH)), filepath: OUTPUT_MODULE_PATH },
);
await writeFile(OUTPUT_MODULE_PATH, moduleSource, "utf8");

const reduction = (100 * (1 - subset.length / source.length)).toFixed(1);
console.log(`source: ${SOURCE_PATH}`);
console.log(`  ${source.length} bytes, sha256 ${sha256(source)}`);
console.log(`subset: ${OUTPUT_WOFF2_PATH}`);
console.log(`  ${subset.length} bytes, sha256 ${sha256(subset)} (${reduction}% 減)`);
