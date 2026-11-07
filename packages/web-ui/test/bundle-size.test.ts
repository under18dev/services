import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * barrel（`@u18/web-ui`）から Google Sans を re-export しないこと
 * （指摘: services-3b、PR #530 のレビュー）。
 *
 * ## 何が起きたか
 *
 * `src/index.ts` に `export * from "./google-sans-font"` があった。
 * `google-sans-font.ts` はトップレベルで `bytesFromBase64(...)` を呼び、
 * 57,576 文字の base64 を `Uint8Array` へデコードする——esbuild は任意の
 * 関数呼び出しを副作用なしとは仮定しないので tree-shaking で落ちない。
 * 結果、`pageSecurityHeaders` だけを barrel から import しただけの
 * バンドルが **729 バイト -> 58,596 バイト**に膨らんだ（services-3b の
 * 実測）。4 Worker 合わせて 27 箇所が barrel を直接 import しており、
 * **フォントをまだ配信していない全 Worker**にこれが入る。
 *
 * `island-classes.ts`（`getButtonClasses()` で `cn` を巻き込んだ、
 * 18.4 -> 36.2 KiB）と同じ形の事故——あちらは「このファイルは何も
 * import しない」という文字列検査で守っているが、今回は barrel から
 * **何を re-export するか**の話なので、実際に esbuild でバンドルして
 * 中身を見る。
 *
 * ## なぜ文字列検査ではなく実バンドルなのか
 *
 * `src/index.ts` が `./google-sans-font` を re-export しているかどうかを
 * 文字列で見る手もあるが、それだと「barrel の別のファイルが内部で
 * `google-sans-font.ts` を import し、それをさらに re-export する」よう
 * な間接的な巻き込みを見逃す。実際にバンドルして、woff2 の中身
 * （base64 化してもマジックナンバーは残る）が入っていないかを見るほうが
 * 確実。
 */

const ENTRY_SOURCE = `import { pageSecurityHeaders } from "@u18/web-ui";\nexport { pageSecurityHeaders };\n`;

/** woff2 のマジックナンバー（"wOF2"）を base64 にした先頭 6 文字。 */
const WOFF2_MAGIC_BASE64 = "d09GMg";

async function bundleBarrelConsumer(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "web-ui-bundle-size-"));
  try {
    const entry = join(dir, "entry.ts");
    await writeFile(entry, ENTRY_SOURCE, "utf8");

    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: ["es2022"],
      write: false,
      logLevel: "silent",
      alias: {
        "@u18/web-ui": join(import.meta.dirname, "../src/index.ts"),
      },
    });

    const [output] = result.outputFiles ?? [];
    if (output === undefined) throw new Error("esbuild produced no output");
    return output.text;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("barrel から pageSecurityHeaders だけを import したバンドル", () => {
  it("空でない（esbuild の設定ミスで空バンドルになっていないか）", async () => {
    // **先にこれを確かめないと、下の「含まれない」検査が意味を持たない。**
    // 空バンドルは何を import しても「含まれない」に通ってしまう
    // （services-3b がこの検算中に実際に踏んだ——パスを間違えて空の
    // バンドルを作り、grep が何も見つけられず「混入なし」と出た）。
    const code = await bundleBarrelConsumer();
    expect(code.length).toBeGreaterThan(100);
  });

  it("Google Sans の woff2（base64）を含まない", async () => {
    const code = await bundleBarrelConsumer();
    expect(
      code,
      "barrel から pageSecurityHeaders だけを import したのに Google Sans の " +
        "base64 が含まれている。src/index.ts が ./google-sans-font を " +
        "re-export していないか確認すること。",
    ).not.toContain(WOFF2_MAGIC_BASE64);
  });
});
