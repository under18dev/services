import { Hono } from "hono";
import { z } from "zod";
import { isAllowedOrigin } from "./origin";
import { problem, statusForUseCaseError } from "./problem";
import { buildSessionCookie } from "./session-cookie";
import type { AppBindings } from "./types";

/**
 * メール OTP（仕様書 8.1 / #9）。
 *
 * `/api/auth/email` 配下にマウントされる。
 * どちらもログイン経路なので Origin を検証する（ログイン CSRF 対策）。
 */
export const otpRoutes = new Hono<AppBindings>();

const purposeSchema = z.enum(["login", "signup", "verify_email", "recovery"]);

const startSchema = z.object({
  email: z.string().min(3).max(254),
  purpose: purposeSchema.default("login"),
});

const verifySchema = z.object({
  email: z.string().min(3).max(254),
  // 桁数だけ見る。中身の検証は定時間比較を行う Repository 側の責務。
  code: z.string().regex(/^\d{6}$/),
  purpose: purposeSchema.default("login"),
});

/** 送信元 IP。Cloudflare が付ける CF-Connecting-IP を正とする。 */
const clientIp = (c: { req: { header: (n: string) => string | undefined } }): string | null =>
  c.req.header("CF-Connecting-IP") ?? null;

otpRoutes.post("/start", async (c) => {
  if (!isAllowedOrigin(c)) return problem(c, 403, "forbidden", "origin not allowed");

  const parsed = startSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "invalid_input", "invalid request body");

  const result = await c.get("container").useCases.startEmailOtp.execute({
    email: parsed.data.email,
    purpose: parsed.data.purpose,
  });
  if (!result.ok) {
    return problem(
      c,
      statusForUseCaseError(result.error.code),
      result.error.code,
      result.error.message,
    );
  }

  // 「送った」とは言わない。アカウントの有無を漏らさないため、
  // 未登録のアドレスでもこの応答を返す（仕様書 9）。
  return c.json({ retryAfterSeconds: result.value.retryAfterSeconds }, 202);
});

otpRoutes.post("/verify", async (c) => {
  if (!isAllowedOrigin(c)) return problem(c, 403, "forbidden", "origin not allowed");

  const parsed = verifySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "invalid_input", "invalid request body");

  const result = await c.get("container").useCases.verifyEmailOtp.execute({
    email: parsed.data.email,
    code: parsed.data.code,
    purpose: parsed.data.purpose,
    userAgent: c.req.header("User-Agent") ?? null,
    ip: clientIp(c),
  });
  if (!result.ok) {
    return problem(
      c,
      statusForUseCaseError(result.error.code),
      result.error.code,
      result.error.message,
    );
  }

  // 平文トークンはここでしか渡せない。応答ボディには載せない
  // （XSS で読まれる。Cookie は HttpOnly なので読めない）。
  c.header(
    "Set-Cookie",
    buildSessionCookie(c.env, result.value.token, result.value.session.expiresAt),
    { append: true },
  );

  return c.json({ created: result.value.created }, result.value.created ? 201 : 200);
});
