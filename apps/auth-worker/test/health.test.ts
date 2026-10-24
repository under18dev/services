import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("D1 に到達できるとき 200 と ok を返す", async () => {
    const response = await SELF.fetch("http://localhost/health");

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["service"]).toBe("u18-auth");
    expect(body["checks"]).toEqual({ database: "ok" });
  });
});

describe("未定義のエンドポイント", () => {
  it("404 を返す", async () => {
    const response = await SELF.fetch("http://localhost/does-not-exist");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });
});

describe("Phase 2 で実装するエンドポイント", () => {
  it.each([
    ["/.well-known/jwks.json", "GET"],
    ["/oauth/authorize", "GET"],
    ["/oauth/token", "POST"],
    ["/oauth/userinfo", "GET"],
    ["/oauth/revoke", "POST"],
  ])("%s は 501 を返す", async (path, method) => {
    const response = await SELF.fetch(`http://localhost${path}`, { method });
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: "not_implemented" });
  });
});
