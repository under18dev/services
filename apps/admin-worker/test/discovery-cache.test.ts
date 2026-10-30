import { describe, expect, it } from "vitest";
import { DiscoveryCache } from "../src/oidc/discovery-cache";
import type { Clock } from "../src/composition/container";

const ISSUER = "https://auth.example.test";

function fakeClock(startMs: number): Clock & { advance: (ms: number) => void } {
  let now = startMs;
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) };
}

function countingFetch(): { fetcher: typeof fetch; calls: number[] } {
  const calls: number[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(calls.length);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth/authorize`,
          token_endpoint: `${ISSUER}/oauth/token`,
          jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ keys: [] }), { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("DiscoveryCache", () => {
  it("TTL 内は再取得しない", async () => {
    const clock = fakeClock(0);
    const { fetcher, calls } = countingFetch();
    const cache = new DiscoveryCache(fetcher, ISSUER, clock);

    await cache.get();
    clock.advance(60_000); // 1 分後
    await cache.get();

    // 1 回ぶん（discovery + jwks の 2 リクエスト）しか増えていない。
    expect(calls.length).toBe(2);
  });

  it("TTL を過ぎたら取り直す", async () => {
    const clock = fakeClock(0);
    const { fetcher, calls } = countingFetch();
    const cache = new DiscoveryCache(fetcher, ISSUER, clock);

    await cache.get();
    clock.advance(6 * 60 * 1000); // 6 分後（TTL は 5 分）
    await cache.get();

    expect(calls.length).toBe(4);
  });
});
