/**
 * `docs/threat-model.md` の ID（`T-1` / `N-5` / `RR-21` のような）が、
 * 参照している側で実在するかを突き合わせる（#371）。
 *
 * ## きっかけ
 *
 * #371 が数えた「今夜の嘘」の中に「存在しない番号への参照」が
 * **12 箇所**あった。脅威モデル・runbook・コメントの `RR-n` は、
 * **番号が変わっても・消えても、参照している側は自分では気づけない。**
 * `#358`（カード ID のビット数）や `claimCodeHash` の検査と同じ家系
 * ——**削除・統合・採番し直しが引き金になる。**
 *
 * ## 2 つの定義のされ方がある
 *
 * - **単独の脅威**（`S-1` / `T-1` / `R-1` / `I-1` / `D-1` / `E-1` / `N-1`）は
 *   `#### T-1：...` という見出しで定義される。
 * - **残存リスク**（`RR-1` 〜）は表の 1 行目のセル（`| RR-1 | ... |`）で
 *   定義される。`RR` は見出しにならない。
 *
 * **`RR` を `R` より先に置く。** JS の正規表現はバックトラックするので
 * 選択肢の順序だけでは誤爆しない（`RR-19` を `R` から試しても、続く
 * `-` が無くて失敗し `RR` へ戻る）が、**順序を読んだ人がそのまま
 * 正しく読めるほうがよい**ので、長い接頭辞を先に置いてある。
 *
 * ## 何を見ないか
 *
 * **数字そのものの正しさは見ない。** 「RR-21 の中身が最新か」は一般には
 * 判定できない（#371 が「全部を機械にはできない」と書いている通り）。
 * ここで見るのは「その番号が **実在するか**」だけ。
 */

const PREFIXES = ["RR", "S", "T", "R", "I", "D", "E", "N"];
const REFERENCE_PATTERN = new RegExp(`\\b(${PREFIXES.join("|")})-(\\d+)\\b`, "g");

const HEADING_DEFINITION = /^#### (S|T|R|I|D|E|N)-(\d+)[：:]/;
const TABLE_ROW_DEFINITION = /^\|\s*(RR-\d+)\s*\|/;

/**
 * `docs/threat-model.md` 本文から、定義済みの ID 一覧を作る。
 *
 * @param {string} source
 * @returns {Set<string>}
 */
export function parseDefinedIds(source) {
  const defined = new Set();
  for (const line of source.split("\n")) {
    const heading = HEADING_DEFINITION.exec(line);
    if (heading !== null) {
      defined.add(`${heading[1]}-${heading[2]}`);
      continue;
    }
    const row = TABLE_ROW_DEFINITION.exec(line);
    if (row !== null) defined.add(row[1]);
  }
  return defined;
}

/**
 * 1 ファイルぶんの参照を集める。
 *
 * **コメントかプレーンな文章かは区別しない。** `RR-21` は Markdown の地の文
 * にも、TypeScript のコメントにも、`.jsonc` のコメントにも現れる——
 * どれも同じ理由（番号が変わると気づけない）で壊れるので、構文で絞らない。
 *
 * @param {string} file
 * @param {string} source
 * @returns {{file: string, line: number, id: string, text: string}[]}
 */
export function findReferences(file, source) {
  const refs = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const match of line.matchAll(REFERENCE_PATTERN)) {
      refs.push({ file, line: i + 1, id: `${match[1]}-${match[2]}`, text: line.trim() });
    }
  }
  return refs;
}
