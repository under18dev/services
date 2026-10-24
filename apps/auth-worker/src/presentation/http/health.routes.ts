import { Hono } from "hono";
import type { AppBindings } from "./types";

export const healthRoutes = new Hono<AppBindings>();

/**
 * 死活監視。
 *
 * D1 へ到達できるかまで確かめる。Worker が起動しているだけでは認証は
 * 成立しないため、バインディングの疎通を含めて 1 つの指標にする。
 * DB へのアクセスは Port 越しに行い、Presentation から Drizzle を触らない。
 */
healthRoutes.get("/health", async (c) => {
  const container = c.get("container");
  const startedAt = Date.now();

  const reachable = await container.services.databaseProbe.ping();

  const body = {
    status: reachable ? ("ok" as const) : ("degraded" as const),
    service: "u18-auth",
    environment: c.env.ENVIRONMENT,
    issuer: c.env.ISSUER,
    checks: { database: reachable ? ("ok" as const) : ("unreachable" as const) },
    latencyMs: Date.now() - startedAt,
    time: container.clock.now().toISOString(),
  };

  return c.json(body, reachable ? 200 : 503);
});
