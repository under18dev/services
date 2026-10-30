import { describe, expect, it } from "vitest";
import { exchangeAuthorizationCode } from "../src/oidc/token-exchange";

const TOKEN_ENDPOINT = "https://auth.example.test/oauth/token";

describe("exchangeAuthorizationCode", () => {
  it("client_secret があれば Basic 認証を付ける", async () => {
    let seenAuth: string | null = null;
    let seenBody: string | null = null;
    const fetcher = (async (_url, init) => {
      seenAuth = (init?.headers as Record<string, string>).Authorization ?? null;
      seenBody = init?.body as string;
      return new Response(JSON.stringify({ id_token: "idt", access_token: "at" }), { status: 200 });
    }) as typeof fetch;

    await exchangeAuthorizationCode({
      fetcher,
      tokenEndpoint: TOKEN_ENDPOINT,
      code: "code1",
      redirectUri: "https://admin.example.test/callback",
      codeVerifier: "verifier1",
      clientId: "u18-admin",
      clientSecret: "shh",
    });

    expect(seenAuth).toBe(`Basic ${btoa("u18-admin:shh")}`);
    const params = new URLSearchParams(seenBody ?? "");
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("code1");
    expect(params.get("code_verifier")).toBe("verifier1");
    expect(params.get("redirect_uri")).toBe("https://admin.example.test/callback");
  });

  it("client_secret が無ければ Authorization ヘッダを付けない（public クライアント）", async () => {
    let seenAuth: string | undefined = "not-checked";
    const fetcher = (async (_url, init) => {
      seenAuth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ id_token: "idt", access_token: "at" }), { status: 200 });
    }) as typeof fetch;

    await exchangeAuthorizationCode({
      fetcher,
      tokenEndpoint: TOKEN_ENDPOINT,
      code: "code1",
      redirectUri: "https://admin.example.test/callback",
      codeVerifier: "verifier1",
      clientId: "u18-admin",
      clientSecret: undefined,
    });

    expect(seenAuth).toBeUndefined();
  });

  it("id_token が欠けていれば拒否する", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ access_token: "at" }), { status: 200 })) as typeof fetch;

    await expect(
      exchangeAuthorizationCode({
        fetcher,
        tokenEndpoint: TOKEN_ENDPOINT,
        code: "code1",
        redirectUri: "https://admin.example.test/callback",
        codeVerifier: "verifier1",
        clientId: "u18-admin",
        clientSecret: undefined,
      }),
    ).rejects.toThrow(/id_token/);
  });

  it("access_token が欠けていれば拒否する", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ id_token: "idt" }), { status: 200 })) as typeof fetch;

    await expect(
      exchangeAuthorizationCode({
        fetcher,
        tokenEndpoint: TOKEN_ENDPOINT,
        code: "code1",
        redirectUri: "https://admin.example.test/callback",
        codeVerifier: "verifier1",
        clientId: "u18-admin",
        clientSecret: undefined,
      }),
    ).rejects.toThrow(/access_token/);
  });

  it("HTTP エラーの本文をそのまま伝える（握り潰さない、#379 と同じ形）", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;

    await expect(
      exchangeAuthorizationCode({
        fetcher,
        tokenEndpoint: TOKEN_ENDPOINT,
        code: "code1",
        redirectUri: "https://admin.example.test/callback",
        codeVerifier: "verifier1",
        clientId: "u18-admin",
        clientSecret: undefined,
      }),
    ).rejects.toThrow(/invalid_grant/);
  });
});
