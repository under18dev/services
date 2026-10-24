import { Hono } from "hono";
import type { AppBindings } from "./types";
import { problem } from "./problem";

/**
 * Passkey / WebAuthn（仕様書 8.1 / #10）。
 *
 * `/api/auth/passkeys` 配下にマウントされる。
 */
export const passkeyRoutes = new Hono<AppBindings>();

passkeyRoutes.post("/register/options", (c) =>
  problem(c, 501, "not_implemented", "passkey registration is not implemented yet"),
);

passkeyRoutes.post("/register/verify", (c) =>
  problem(c, 501, "not_implemented", "passkey registration is not implemented yet"),
);

passkeyRoutes.post("/login/options", (c) =>
  problem(c, 501, "not_implemented", "passkey login is not implemented yet"),
);

passkeyRoutes.post("/login/verify", (c) =>
  problem(c, 501, "not_implemented", "passkey login is not implemented yet"),
);
