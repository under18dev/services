import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GOOGLE_SANS_FONT_BYTES } from "@u18/web-ui/google-sans-font";
import { GOOGLE_SANS_FONT_PATH, KIWA_STYLESHEET_PATH } from "../src/presentation/http/ui/asset-paths";

const BASE = "http://localhost";

/**
 * Google Sans の配線（design-system 連携、PR2）。
 *
 * バイト等価も CSP も既にあるが、**それらが全部緑でもフォントが
 * 当たっていない状態はあり得る**（指摘: services-3b）。配信されている
 * kiwa.css の中身まで読む。
 */
describe("Google Sans の配線", () => {
  it("配信中の kiwa.css が Google Sans の @font-face を持つ", async () => {
    const response = await SELF.fetch(`${BASE}${KIWA_STYLESHEET_PATH}`);
    expect(response.status).toBe(200);

    const css = await response.text();
    expect(css).toContain('font-family: "Google Sans"');
    const fontFileName = GOOGLE_SANS_FONT_PATH.split("/").pop();
    expect(css).toContain(`url("./${fontFileName}")`);

    const fontFaceBlocks = css.match(/@font-face\s*\{[^}]*font-family:\s*"Google Sans"[^}]*\}/g);
    expect(fontFaceBlocks).toHaveLength(1);
    expect(fontFaceBlocks?.[0]).not.toContain("italic");
  });

  it("フォント本体が実際に配信され、バイトが一致する", async () => {
    const response = await SELF.fetch(`${BASE}${GOOGLE_SANS_FONT_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("font/woff2");

    const served = new Uint8Array(await response.arrayBuffer());
    expect(served).toEqual(GOOGLE_SANS_FONT_BYTES);
  });

  it("body の font-family が Google Sans に揃っている（--gdg-font-sans 経由）", async () => {
    const response = await SELF.fetch(`${BASE}${KIWA_STYLESHEET_PATH}`);
    const css = await response.text();

    expect(css).toMatch(/body\{[^}]*font-family:var\(--gdg-font-sans\)/);
  });
});
