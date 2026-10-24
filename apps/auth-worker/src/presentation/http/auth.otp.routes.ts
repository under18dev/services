import { Hono } from "hono";
import type { AppBindings } from "./types";
import { problem } from "./problem";

/**
 * メール OTP（仕様書 8.1 / #9）。
 *
 * `/api/auth/email` 配下にマウントされる。
 */
export const otpRoutes = new Hono<AppBindings>();

otpRoutes.post("/start", (c) =>
  problem(c, 501, "not_implemented", "email OTP start is not implemented yet"),
);

otpRoutes.post("/verify", (c) =>
  problem(c, 501, "not_implemented", "email OTP verify is not implemented yet"),
);
