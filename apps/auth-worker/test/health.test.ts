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

describe("Phase 2 の OIDC エンドポイントは全て実装済み", () => {
  // 実装の中身はそれぞれの専用ファイルにある:
  //   JWKS（#14） → jwks.test.ts
  //   /oauth/authorize（#15） → oauth-authorize.test.ts
  //   /oauth/token（#16） → oauth-token.test.ts
  //   /oauth/userinfo・/oauth/revoke（#17） → oauth-userinfo.test.ts, oauth-revoke.test.ts
  //
  // ここに残してあるのは「ルートが登録されていること」だけを見る哨戒線。
  // 401 や 400 を返すのは認証情報を付けていないためで、正常である。
  // 501 / 404 に戻ったらルートの配線が外れたことを意味する。
  it.each([
    ["/oauth/userinfo", "GET"],
    ["/oauth/userinfo", "POST"],
    ["/oauth/revoke", "POST"],
  ])("%s (%s) は 501 でも 404 でもない", async (path, method) => {
    const response = await SELF.fetch(`http://localhost${path}`, { method });

    expect(response.status).not.toBe(501);
    expect(response.status).not.toBe(404);
  });
});
