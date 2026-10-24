import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const fetchDiscovery = async (): Promise<Record<string, unknown>> => {
  const response = await SELF.fetch("http://localhost/.well-known/openid-configuration");
  return (await response.json()) as Record<string, unknown>;
};

describe("OIDC Discovery", () => {
  it("issuer と各エンドポイントを返す", async () => {
    const body = await fetchDiscovery();

    expect(body["issuer"]).toBe("http://localhost:8787");
    expect(body["authorization_endpoint"]).toBe("http://localhost:8787/oauth/authorize");
    expect(body["token_endpoint"]).toBe("http://localhost:8787/oauth/token");
    expect(body["jwks_uri"]).toBe("http://localhost:8787/.well-known/jwks.json");
  });

  it("Authorization Code Flow のみを広告する", async () => {
    const body = await fetchDiscovery();

    expect(body["response_types_supported"]).toEqual(["code"]);
    expect(body["grant_types_supported"]).toEqual(["authorization_code"]);
    // Implicit / Password Grant は提供しない（仕様書 9）。
    expect(body["grant_types_supported"]).not.toContain("implicit");
    expect(body["grant_types_supported"]).not.toContain("password");
  });

  it("PKCE は S256 のみを広告する", async () => {
    const body = await fetchDiscovery();

    expect(body["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(body["code_challenge_methods_supported"]).not.toContain("plain");
  });

  it("scope は openid / profile / email のみ", async () => {
    const body = await fetchDiscovery();
    expect(body["scopes_supported"]).toEqual(["openid", "profile", "email"]);
  });
});
