import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDarkMedia } from "../scripts/lib/gdg-dark-media.mjs";

const TOKENS_CSS = join(import.meta.dirname, "..", "src", "gdg", "tokens.css");
const GENERATED = join(import.meta.dirname, "..", "src", "gdg", "generated", "dark-media.css");

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
});
