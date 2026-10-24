import { Hono } from "hono";
import { otpRoutes } from "./auth.otp.routes";
import { passkeyRoutes } from "./auth.passkey.routes";
import { buildClearedSessionCookie, readSessionCookie } from "./session-cookie";
import type { AppBindings } from "./types";
import { isAllowedOrigin } from "./origin";
import { problem, statusForUseCaseError } from "./problem";

/**
 * アカウント認証 API（仕様書 8.1）。
 *
 * 方式ごとの実装は auth.otp.routes.ts / auth.passkey.routes.ts に分ける。
 * ここは入口の組み立てと、方式に依存しないログアウトだけを持つ。
 */
export const authRoutes = new Hono<AppBindings>();

authRoutes.route("/email", otpRoutes);
authRoutes.route("/passkeys", passkeyRoutes);

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
