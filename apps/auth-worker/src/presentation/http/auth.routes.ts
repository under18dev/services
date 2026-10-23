import { Hono } from "hono";
import type { AppBindings } from "./app";
import { problem } from "./problem";

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

authRoutes.post("/logout", (c) =>
  problem(c, 501, "not_implemented", "logout is not implemented yet"),
);
