import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { AppBindings } from "./app";

export const healthRoutes = new Hono<AppBindings>();

/**
 * 死活監視。
 *
 * D1 へ到達できるかまで確かめる。Worker が起動しているだけでは
 * 認証は成立しないため、バインディングの疎通を含めて 1 つの指標にする。
 */
healthRoutes.get("/health", async (c) => {
  const container = c.get("container");
  const startedAt = Date.now();

  let database: "ok" | "unreachable" = "ok";
  try {
    await container.db.run(sql`select 1`);
  } catch (error) {
    console.error("health: database unreachable", error);
    database = "unreachable";
  }

  const body = {
    status: database === "ok" ? ("ok" as const) : ("degraded" as const),
    service: "u18-auth",
    environment: c.env.ENVIRONMENT,
    issuer: c.env.ISSUER,
    checks: { database },
    latencyMs: Date.now() - startedAt,
    time: container.clock.now().toISOString(),
  };

  return c.json(body, database === "ok" ? 200 : 503);
});
