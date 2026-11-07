import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GOOGLE_SANS_FONT_BYTES } from "@u18/web-ui/google-sans-font";
import { createApp } from "../src/presentation/http/app";
import { GOOGLE_SANS_FONT_PATH, KIWA_STYLESHEET_PATH } from "../src/presentation/http/ui/asset-paths";
import { executionContext, ORIGIN } from "./helpers";

/**
 * Google Sans の配線（design-system 連携、PR2）。
 *
 * ## なぜこのテストが要るのか
 *
 * バイト等価（`google-sans-font.test.ts`）も CSP（`page-headers.test.ts`）も
 * 既にあるが、**それらが全部緑でもフォントが当たっていない状態はあり得る**
 * （指摘: services-3b）。`font-display: swap` のせいで、配信ルートが
 * 消えても画面はフォールバックフォントで普通に描かれる——テストでも
 * 見た目でも気づけない。ここでは実際に配信されている `kiwa.<hash>.css`
 * の中身を読み、`@font-face` が存在してフォント本体の URL を指している
 * ことまで確かめる。
 */
describe("Google Sans の配線", () => {
  it("配信中の kiwa.css が Google Sans の @font-face を持つ", async () => {
    const app = createApp();
    const response = await app.fetch(
      new Request(`${ORIGIN}${KIWA_STYLESHEET_PATH}`),
      env,
      executionContext(),
    );
    expect(response.status).toBe(200);

    const css = await response.text();
    expect(css).toContain('font-family: "Google Sans"');
    // 相対パスなので、ハッシュ付きファイル名だけが一致すればよい
    // （kiwa.css と同じディレクトリから配信される前提、asset-paths.ts を参照）。
    const fontFileName = GOOGLE_SANS_FONT_PATH.split("/").pop();
    expect(css).toContain(`url("./${fontFileName}")`);

    // Google Sans の @font-face が normal 1 本だけであることを固定する——
    // 積んだ瞬間にこのテストで気づく。**CSS 全体に "font-style: italic" が
    // 無いことは見ない**——GDG の .gdg-typography-blockquote が引用ブロック
    // 用に持っており（u18 は使っていない）、無関係にヒットしてしまうため。
    const fontFaceBlocks = css.match(/@font-face\s*\{[^}]*font-family:\s*"Google Sans"[^}]*\}/g);
    expect(fontFaceBlocks).toHaveLength(1);
    expect(fontFaceBlocks?.[0]).not.toContain("italic");
  });

  it("フォント本体が実際に配信され、バイトが一致する", async () => {
    const app = createApp();
    const response = await app.fetch(
      new Request(`${ORIGIN}${GOOGLE_SANS_FONT_PATH}`),
      env,
      executionContext(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("font/woff2");

    const served = new Uint8Array(await response.arrayBuffer());
    expect(served).toEqual(GOOGLE_SANS_FONT_BYTES);
  });

  it("body の font-family が Google Sans に揃っている（--gdg-font-sans 経由）", async () => {
    const app = createApp();
    const response = await app.fetch(
      new Request(`${ORIGIN}${KIWA_STYLESHEET_PATH}`),
      env,
      executionContext(),
    );
    const css = await response.text();

    expect(css).toMatch(/body\{[^}]*font-family:var\(--gdg-font-sans\)/);
  });
});
