import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { RpcIdentityGateway } from "./infrastructure/rpc/identity.gateway";
import type { IdentityGateway } from "./application/ports";
import type { IdentityFailure } from "./domain/errors";

type Bindings = Env;
type Variables = { identity: IdentityGateway };

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use("*", secureHeaders());

app.use("*", async (c, next) => {
  c.set("identity", new RpcIdentityGateway(c.env.IDENTITY));
  await next();
});

const COOKIE_NAME = "u18_session";

function statusFor(failure: IdentityFailure): 401 | 403 | 404 | 503 {
  switch (failure.kind) {
    case "unauthenticated":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "identity_unavailable":
      return 503;
  }
}

app.get("/health", (c) =>
  c.json({ status: "ok", service: "u18-dashboard", environment: c.env.ENVIRONMENT }),
);

/**
 * BFF: 自分のプロフィールを返す。
 *
 * dashboard-worker は Identity DB に触らず、必ず RPC 越しに問い合わせる
 * （仕様書 2.2 / 4.1）。
 */
app.get("/api/me", async (c) => {
  const token = getCookie(c, COOKIE_NAME);
  if (token === undefined) return c.json({ error: "unauthenticated" }, 401);

  const result = await c.get("identity").getProfile(token);
  if (!result.ok) return c.json({ error: result.failure.kind }, statusFor(result.failure));
  if (result.value === null) return c.json({ error: "unauthenticated" }, 401);

  return c.json(result.value);
});

app.get("/api/me/sessions", async (c) => {
  const token = getCookie(c, COOKIE_NAME);
  if (token === undefined) return c.json({ error: "unauthenticated" }, 401);

  const result = await c.get("identity").listSessions(token);
  if (!result.ok) return c.json({ error: result.failure.kind }, statusFor(result.failure));

  return c.json({ sessions: result.value });
});

app.delete("/api/me/sessions/:id", async (c) => {
  const token = getCookie(c, COOKIE_NAME);
  if (token === undefined) return c.json({ error: "unauthenticated" }, 401);

  // 状態を変える操作なので Origin を確かめる（仕様書 9 CSRF）。
  const origin = c.req.header("Origin");
  if (origin !== undefined && new URL(c.req.url).origin !== origin) {
    return c.json({ error: "forbidden" }, 403);
  }

  const result = await c.get("identity").revokeSession(token, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.failure.kind }, statusFor(result.failure));

  return c.json(result.value);
});

export default app satisfies ExportedHandler<Bindings>;
