import { Hono } from "hono";
import { buildClearedSessionCookie, readSessionCookie } from "./session-cookie";
import type { AppBindings } from "./types";
import { isAllowedOrigin } from "./origin";
import { problem, statusForUseCaseError } from "./problem";

/**
 * アカウント認証 API（仕様書 8.1）。
 *
 * Phase 1 の残りで実装する。更新系は CSRF 対策と Origin 検証を必ず通すこと。
 */
export const authRoutes = new Hono<AppBindings>();

// --- Email OTP ---
authRoutes.post("/email/start", (c) =>
  problem(c, 501, "not_implemented", "email OTP start is not implemented yet"),
);
authRoutes.post("/email/verify", (c) =>
  problem(c, 501, "not_implemented", "email OTP verify is not implemented yet"),
);

// --- Passkey (WebAuthn) ---
authRoutes.post("/passkeys/register/options", (c) =>
  problem(c, 501, "not_implemented", "passkey registration is not implemented yet"),
);
authRoutes.post("/passkeys/register/verify", (c) =>
  problem(c, 501, "not_implemented", "passkey registration is not implemented yet"),
);
authRoutes.post("/passkeys/login/options", (c) =>
  problem(c, 501, "not_implemented", "passkey login is not implemented yet"),
);
authRoutes.post("/passkeys/login/verify", (c) =>
  problem(c, 501, "not_implemented", "passkey login is not implemented yet"),
);

/**
 * ログアウト。
 *
 * 状態を変えるので Origin を検証する。ただし **Cookie が無くても 204 を返す**。
 * 「ログアウトする対象が無かった」と区別できる応答を返すと、トークンの
 * 実在を探る手段になるうえ、利用者から見た結果は同じ。
 */
authRoutes.post("/logout", async (c) => {
  if (!isAllowedOrigin(c)) {
    return problem(c, 403, "forbidden", "origin not allowed");
  }

  // どの応答経路でも Cookie は必ず落とす。サーバー側の失効に失敗しても、
  // ブラウザに使えないトークンを残さない。
  c.header("Set-Cookie", buildClearedSessionCookie(c.env), { append: true });

  const token = readSessionCookie(c);
  if (token === null) return c.body(null, 204);

  const allDevices = c.req.query("all") === "true";
  const result = await c.get("container").useCases.logout.execute({
    sessionToken: token,
    allDevices,
  });
  if (!result.ok) {
    return problem(
      c,
      statusForUseCaseError(result.error.code),
      result.error.code,
      result.error.message,
    );
  }

  return c.body(null, 204);
});
