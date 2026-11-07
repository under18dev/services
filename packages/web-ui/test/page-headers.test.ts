import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { pageSecurityHeaders } from "../src/page-headers";

/**
 * 共有 CSP（4 Worker 全部がこの定数を import する、`page-headers.ts` の
 * JSDoc を参照）。
 *
 * **`font-src` が無いだけでは画面は壊れない。** CSP 仕様では省略時に
 * `default-src` へフォールバックするので、`default-src 'none'` のままだと
 * 同一オリジンの woff2 でもブラウザが黙ってブロックし、`font-display: swap`
 * のフォールバックフォントで普通に描画される——見た目でもテストの出力でも
 * 気づけない。ヘッダ文字列そのものを見る。
 */
describe("pageSecurityHeaders の CSP", () => {
  async function cspHeader(): Promise<string> {
    const app = new Hono();
    app.use("*", pageSecurityHeaders);
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/");
    return res.headers.get("Content-Security-Policy") ?? "";
  }

  it("font-src 'self' を含む（自前配信する Google Sans のため）", async () => {
    expect(await cspHeader()).toContain("font-src 'self'");
  });

  it("default-src 'none' のまま（font-src を足しても他を緩めていない）", async () => {
    expect(await cspHeader()).toContain("default-src 'none'");
  });

  it("script-src / style-src は 'self' のまま", async () => {
    const csp = await cspHeader();
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
  });
});
