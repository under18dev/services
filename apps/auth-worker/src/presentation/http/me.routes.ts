import { Hono } from "hono";
import { buildClearedSessionCookie, readSessionCookie } from "./session-cookie";
import type { AppBindings } from "./types";
import { problem, statusForUseCaseError } from "./problem";

/**
 * 自分自身に関する API（仕様書 8.1）。
 *
 * userId をパスやボディで受け取らない。対象は常に Cookie のセッションから導く。
 */
export const meRoutes = new Hono<AppBindings>();

meRoutes.get("/me", async (c) => {
  const token = readSessionCookie(c);
  if (token === null) return problem(c, 401, "unauthenticated", "no session");

  const container = c.get("container");
  const result = await container.useCases.getSession.execute({ sessionToken: token });
  if (!result.ok) {
    return problem(
      c,
      statusForUseCaseError(result.error.code),
      result.error.code,
      result.error.message,
    );
  }
  if (result.value === null) return problem(c, 401, "unauthenticated", "session is not valid");

  const user = await container.repositories.users.findById(result.value.userId);
  if (user === null) return problem(c, 401, "unauthenticated", "session is not valid");

  const props = user.snapshot();
  return c.json({
    id: props.id,
    username: props.username,
    displayName: props.displayName,
    email: props.email,
    emailVerified: props.emailVerified,
    status: props.status,
    createdAt: props.createdAt.toISOString(),
  });
});

meRoutes.patch("/me", (c) =>
  // Phase 1 の残り: Origin 検証 + CSRF トークン + username 変更時の再認証。
  problem(c, 501, "not_implemented", "profile update is not implemented yet"),
);

meRoutes.get("/me/sessions", async (c) => {
  const token = readSessionCookie(c);
  if (token === null) return problem(c, 401, "unauthenticated", "no session");

  const container = c.get("container");
  const result = await container.useCases.listSessions.execute({ sessionToken: token });
  if (!result.ok) {
    return problem(
      c,
      statusForUseCaseError(result.error.code),
      result.error.code,
      result.error.message,
    );
  }
  if (result.value === null) return problem(c, 401, "unauthenticated", "session is not valid");

  return c.json({
    sessions: result.value.map(({ session, current }) => ({
      id: session.id,
      current,
      authMethod: session.authMethod,
      createdAt: session.createdAt.toISOString(),
      lastSeenAt: session.lastSeenAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      userAgent: session.userAgent,
    })),
  });
});

meRoutes.delete("/me/sessions/:id", async (c) => {
  const token = readSessionCookie(c);
  if (token === null) return problem(c, 401, "unauthenticated", "no session");

  // 状態を変える Cookie 認証 API なので Origin を確かめる（仕様書 8.1 / 9）。
  // Origin が無い場合も拒否する。「無ければ通す」にすると、ヘッダを落とせる
  // 経路があった時点で CSRF 対策が SameSite 頼みになる。
  const origin = c.req.header("Origin");
  if (origin !== c.env.ISSUER) {
    return problem(c, 403, "forbidden", "origin not allowed");
  }

  const container = c.get("container");
  const result = await container.useCases.revokeSession.execute({
    sessionToken: token,
    targetSessionId: c.req.param("id"),
  });
  if (!result.ok) {
    return problem(
      c,
      statusForUseCaseError(result.error.code),
      result.error.code,
      result.error.message,
    );
  }

  // 自分自身のセッションを消した場合は Cookie も落とす。
  if (result.value.revoked) {
    c.header("Set-Cookie", buildClearedSessionCookie(c.env), { append: true });
  }
  return c.json({ revoked: result.value.revoked });
});
