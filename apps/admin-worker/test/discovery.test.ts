import { describe, expect, it } from "vitest";
import { fetchDiscovery, fetchJwks } from "../src/oidc/discovery";

const ISSUER = "https://auth.example.test";

function fakeFetch(responses: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const entry = responses[url];
    if (entry === undefined) throw new Error(`fake fetch: 想定していない URL: ${url}`);
    return new Response(JSON.stringify(entry.body), { status: entry.status });
  }) as typeof fetch;
}

describe("fetchDiscovery", () => {
  const url = `${ISSUER}/.well-known/openid-configuration`;

  it("正しい応答を読む", async () => {
    const fetcher = fakeFetch({
      [url]: {
        status: 200,
        body: {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth/authorize`,
          token_endpoint: `${ISSUER}/oauth/token`,
          jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        },
      },
    });

    const doc = await fetchDiscovery(fetcher, ISSUER);
    expect(doc.issuer).toBe(ISSUER);
    expect(doc.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
  });

  it("issuer が要求元と一致しなければ拒否する（Discovery なりすまし対策）", async () => {
    const fetcher = fakeFetch({
      [url]: {
        status: 200,
        body: {
          issuer: "https://evil.example",
          authorization_endpoint: `${ISSUER}/oauth/authorize`,
          token_endpoint: `${ISSUER}/oauth/token`,
          jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        },
      },
    });

    await expect(fetchDiscovery(fetcher, ISSUER)).rejects.toThrow(/issuer/);
  });

  it("HTTP エラーをそのまま投げる", async () => {
    const fetcher = fakeFetch({ [url]: { status: 500, body: {} } });
    await expect(fetchDiscovery(fetcher, ISSUER)).rejects.toThrow(/500/);
  });

  it("必須項目が欠けていれば拒否する", async () => {
    const fetcher = fakeFetch({ [url]: { status: 200, body: { issuer: ISSUER } } });
    await expect(fetchDiscovery(fetcher, ISSUER)).rejects.toThrow(/形が違う/);
  });
});

describe("fetchJwks", () => {
  const jwksUri = `${ISSUER}/.well-known/jwks.json`;

  it("keys 配列を読む", async () => {
    const fetcher = fakeFetch({ [jwksUri]: { status: 200, body: { keys: [{ kid: "k1" }] } } });
    const jwks = await fetchJwks(fetcher, jwksUri);
    expect(jwks.keys).toHaveLength(1);
  });

  it("keys が配列でなければ拒否する", async () => {
    const fetcher = fakeFetch({ [jwksUri]: { status: 200, body: {} } });
    await expect(fetchJwks(fetcher, jwksUri)).rejects.toThrow(/形が違う/);
  });
});
