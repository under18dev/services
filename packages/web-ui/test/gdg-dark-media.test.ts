import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDarkMedia, buildVarNamesModule } from "../scripts/lib/gdg-dark-media.mjs";

const TOKENS_CSS = join(import.meta.dirname, "..", "src", "gdg", "tokens.css");
const GENERATED = join(import.meta.dirname, "..", "src", "gdg", "generated", "dark-media.css");
const GENERATED_VAR_NAMES = join(
  import.meta.dirname,
  "..",
  "src",
  "gdg",
  "generated",
  "dark-media-var-names.ts",
);

/**
 * `.dark { ... }` が宣言する変数名の集合と、生成済みの
 * `generated/dark-media.css` が持つ変数名の集合が一致することを確かめる
 * （GDG デザイン移行 PR1）。
 *
 * 2 つの assert を**両方**必ず書く。片方だけだと、セレクタの取り違え等で
 * 両側とも空集合になったときに「空集合 == 空集合」で緑になる
 * （このリポジトリでは同じ形の穴を過去に繰り返し踏んでいる）。
 */
describe("gdg-dark-media", () => {
  it("tokens.css の .dark と generated/dark-media.css の変数名の集合が一致する", () => {
    const tokensCssText = readFileSync(TOKENS_CSS, "utf8");
    const built = buildDarkMedia(tokensCssText);
    if (!built.ok) {
      throw new Error(`tokens.css の .dark ブロックが読めません: ${built.errors.join(" / ")}`);
    }

    const generatedText = readFileSync(GENERATED, "utf8");
    const generatedVarNames = new Set(
      Array.from(generatedText.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g), (m) => m[1]),
    );
    const expectedVarNames = new Set(built.varNames);

    expect(generatedVarNames).toEqual(expectedVarNames);
    expect(generatedVarNames.size).toBeGreaterThan(0);
  });

  it("generated/dark-media.css が最新である（コミット済みの生成物と再生成結果が一致する）", () => {
    const tokensCssText = readFileSync(TOKENS_CSS, "utf8");
    const built = buildDarkMedia(tokensCssText);
    if (!built.ok) {
      throw new Error(`tokens.css の .dark ブロックが読めません: ${built.errors.join(" / ")}`);
    }

    const committed = readFileSync(GENERATED, "utf8");
    expect(committed).toBe(built.content);
  });

  /**
   * `dark-media-var-names.ts` も生成物。Worker のテストは workerd の中で
   * 動き、`tokens.css` を直接読めないため、この配列を `@u18/web-ui` 経由で
   * 読んでいる（`kiwa-stylesheet.test.ts` 各ファイルを参照）。こちらが
   * 古いままだと、Worker 側の比較が黙って正しくない期待値と突き合わせる
   * ことになる——生成物どうしの整合も、CSS と同じ強さで見る。
   */
  it("generated/dark-media-var-names.ts が最新である", () => {
    const tokensCssText = readFileSync(TOKENS_CSS, "utf8");
    const built = buildDarkMedia(tokensCssText);
    if (!built.ok) {
      throw new Error(`tokens.css の .dark ブロックが読めません: ${built.errors.join(" / ")}`);
    }

    const committed = readFileSync(GENERATED_VAR_NAMES, "utf8");
    expect(committed).toBe(buildVarNamesModule(built.varNames));
  });
});
