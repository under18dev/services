import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { create as createFont } from "fontkit";
import { describe, expect, it } from "vitest";
import { GOOGLE_SANS_FONT_BYTES } from "../src/google-sans-font";
import { GOOGLE_SANS_FONT_BASE64 } from "../src/generated/google-sans-font";

/**
 * サブセット済み Google Sans の整合性（design-system 連携）。
 *
 * `scripts/subset-google-sans.mjs` は手で毎回は走らない（`build-client.mjs`
 * と違い、ビルドのたびに自動で再生成しない）。**3 つのファイルが別々に
 * コミットされている**——vendor 元の `GoogleSans.woff2`、スクリプトの出力
 * `GoogleSans.subset.woff2`、それを base64 にした `google-sans-font.ts`。
 * 手で 1 つだけ更新する余地があるので、ここで SHA-256 を固定して検査する。
 *
 * 値がずれたら `pnpm --filter @u18/web-ui run build:font` を再実行すること。
 */

const ROOT = join(import.meta.dirname, "..");

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("vendor 元・生成物の SHA-256", () => {
  it("vendor 元（GoogleSans.woff2、gdg-jp/design-system から）が置き換わっていない", async () => {
    const source = await readFile(join(ROOT, "assets/fonts/GoogleSans.woff2"));
    expect(source.length).toBe(1_584_340);
    expect(sha256(source)).toBe("1cffb3e594b6740f9b7957316941f714f10f4593ae4ca8c4243ce1edca380409");
  });

  it("サブセット出力（GoogleSans.subset.woff2）が手で編集されていない", async () => {
    const subset = await readFile(join(ROOT, "assets/fonts/GoogleSans.subset.woff2"));
    expect(sha256(subset)).toBe("a6edf40f7eab0e8b019884a04d620fca1c3fd994fbdeace326b29a0785948558");
  });
});

describe("base64 の往復", () => {
  it("配信用バイト列が、コミットされている .woff2 とバイト単位で一致する", async () => {
    const onDisk = await readFile(join(ROOT, "assets/fonts/GoogleSans.subset.woff2"));
    expect(Buffer.from(GOOGLE_SANS_FONT_BYTES)).toEqual(onDisk);
  });

  it("base64 文字列をデコードすると同じバイト列になる（往復が壊れていない）", () => {
    const decoded = Buffer.from(GOOGLE_SANS_FONT_BASE64, "base64");
    expect(Buffer.from(GOOGLE_SANS_FONT_BYTES)).toEqual(decoded);
  });
});

describe("可変フォントの軸", () => {
  it("wght 軸は 400〜700 の可変のまま、opsz・GRAD は削ってある", () => {
    // GDG の `--gdg-weight-heading: 650` のような中間値を描画できるのは
    // `wght` が可変のままだから。ここが静的ウェイトへ固定されてしまうと
    // 見出しの太さが GDG から変わる——サブセットのたびに実測で固定する。
    const font = createFont(Buffer.from(GOOGLE_SANS_FONT_BYTES));
    const variable = Array.isArray(font) ? font[0] : font;
    expect(variable.variationAxes).toHaveProperty("wght");
    expect(variable.variationAxes.wght).toMatchObject({ min: 400, max: 700 });
    expect(variable.variationAxes).not.toHaveProperty("opsz");
    expect(variable.variationAxes).not.toHaveProperty("GRAD");
  });
});
