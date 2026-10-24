import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createContainer } from "../src/composition/container";

function envWith(overrides: Record<string, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

/**
 * 設定不備があっても、無関係なエンドポイントを巻き添えにしないこと（#53）。
 *
 * コンテナはリクエストごとに組み立てられるので、組み立てで throw すると
 * メールや IP ハッシュと無関係な /health や Discovery まで 500 になる。
 */
describe("設定不備の影響範囲", () => {
  const brokenProd = {
    ENVIRONMENT: "production",
    EMAIL: undefined,
    IP_HASH_PEPPER: undefined,
  };

  it("EMAIL も pepper も無い本番設定でもコンテナは組み立てられる", () => {
    expect(() => createContainer(envWith(brokenProd))).not.toThrow();
  });

  it("OTP を送ろうとした時点で失敗する", async () => {
    const container = createContainer(envWith(brokenProd));

    await expect(
      container.services.email.sendOtp({
        to: "taro@example.com",
        code: "123456",
        purpose: "login",
        expiresInMinutes: 5,
      }),
    ).rejects.toThrow(/not configured/);
  });

  it("IP をハッシュ化しようとした時点で失敗する", async () => {
    const container = createContainer(envWith(brokenProd));

    await expect(container.services.ipHasher.hash("203.0.113.1")).rejects.toThrow(/not configured/);
  });

  it("development では既定値で動く", async () => {
    const container = createContainer(envWith({ ENVIRONMENT: "development", EMAIL: undefined }));

    await expect(container.services.ipHasher.hash("203.0.113.1")).resolves.toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("/health と Discovery は設定不備の巻き添えにならない", async () => {
    // 実環境では env が壊れていても、この 2 つは応答し続ける必要がある。
    const [health, discovery] = await Promise.all([
      SELF.fetch("http://localhost/health"),
      SELF.fetch("http://localhost/.well-known/openid-configuration"),
    ]);

    expect(health.status).toBe(200);
    expect(discovery.status).toBe(200);
  });
});

describe("Origin 検証の正規化 (#46)", () => {
  const cookie = "u18_session=some-token-value";

  it.each([
    ["末尾スラッシュ", "http://localhost:8787/"],
    ["大文字", "HTTP://LOCALHOST:8787"],
  ])("%s を含む Origin も同一オリジンとして扱う", async (_label, origin) => {
    // ISSUER との文字列厳密一致だと、設定が 1 文字違うだけで
    // 更新系 API が全件 403 になる。
    const response = await SELF.fetch("http://localhost/api/me/sessions/ses_x", {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: origin },
    });

    // Origin は通り、セッションが無効なので 401 まで進む。
    expect(response.status).toBe(401);
  });

  it("別オリジンは拒否する", async () => {
    const response = await SELF.fetch("http://localhost/api/me/sessions/ses_x", {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });

  it("ログアウトも Origin 欠如を拒否する", async () => {
    const response = await SELF.fetch("http://localhost/api/auth/logout", { method: "POST" });
    expect(response.status).toBe(403);
  });

  it("正しい Origin ならログアウトは 204", async () => {
    const response = await SELF.fetch("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { Origin: "http://localhost:8787" },
    });
    expect(response.status).toBe(204);
  });
});
