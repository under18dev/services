import { describe, expect, it } from "vitest";
import { buildAuthorizationUrl } from "../src/oidc/authorize-url";

describe("buildAuthorizationUrl", () => {
  it("PKCE と state / nonce を全部載せる", () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: "https://auth.under18.dev/oauth/authorize",
        clientId: "u18-admin",
        redirectUri: "https://admin.under18.dev/callback",
        scope: "openid admin",
        state: "s1",
        nonce: "n1",
        codeChallenge: "c1",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://auth.under18.dev/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("u18-admin");
    expect(url.searchParams.get("redirect_uri")).toBe("https://admin.under18.dev/callback");
    expect(url.searchParams.get("scope")).toBe("openid admin");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("nonce")).toBe("n1");
    expect(url.searchParams.get("code_challenge")).toBe("c1");
    // **S256 以外を送らない。** u18 Identity は PKCE S256 を必須にしている
    // （decision 9）ので、ここで固定しておく——将来別の値を渡せる形に
    // 変えても、既定が plain に戻らないようにする。
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // **省けば乗らない。** 呼び出し側が明示しない限り、要求しない
    // （acr_values の有無がそのまま要求の有無になる）。
    expect(url.searchParams.has("acr_values")).toBe(false);
  });

  it("acrValues を渡せば acr_values として乗る（決定 8、#390）", () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: "https://auth.under18.dev/oauth/authorize",
        clientId: "u18-admin",
        redirectUri: "https://admin.under18.dev/callback",
        scope: "openid",
        state: "s1",
        nonce: "n1",
        codeChallenge: "c1",
        acrValues: "passkey",
      }),
    );

    expect(url.searchParams.get("acr_values")).toBe("passkey");
  });
});
