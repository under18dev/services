/**
 * `gdg-dark-media.mjs` の型だけを `test/gdg-dark-media.test.ts` へ渡す
 * 宣言ファイル（GDG デザイン移行 PR1）。
 *
 * **`tsconfig.json` に `allowJs` を足す代わりにこれを置いた。** `allowJs` +
 * `include` の拡張はパッケージ全体の型検査範囲を広げる副作用を持つ——
 * 実際、`scripts/**\/*.mjs` を足した版は CI で `scripts/subset-google-sans.mjs`
 * （#530、別 PR が追加した無関係なファイル）まで型検査の対象に巻き込み、
 * そちらの既存の型エラーで落ちた。隣に `.d.ts` を置くだけなら、
 * この 1 ファイルの型だけが見える。
 */
export function buildDarkMedia(
  tokensCssText: string,
): { ok: true; varNames: string[]; content: string } | { ok: false; errors: string[] };

export function buildVarNamesModule(varNames: string[]): string;
