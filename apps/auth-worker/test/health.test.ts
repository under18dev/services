import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyMigrations } from "./helpers";

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as ExecutionContext;

describe("GET /health", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("D1 に到達できるとき 200 と ok を返す", async () => {
    const response = await worker.fetch!(
      new Request("http://localhost/health"),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["service"]).toBe("u18-auth");
    expect(body["checks"]).toEqual({ database: "ok" });
  });
});

describe("未定義のエンドポイント", () => {
  it("404 を返す", async () => {
    const response = await worker.fetch!(
      new Request("http://localhost/does-not-exist"),
      env,
      ctx,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });
});
