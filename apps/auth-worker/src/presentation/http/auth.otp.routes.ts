import { Hono } from "hono";
import { z } from "zod";
import { isAllowedOrigin } from "./origin";
import { problem, statusForUseCaseError } from "./problem";
import { clientIp, enforceIpRateLimit } from "./rate-limit";
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

otpRoutes.post("/start", async (c) => {
  if (!isAllowedOrigin(c)) return problem(c, 403, "forbidden", "origin not allowed");

  // **本文を読む前に**かける。読んでから判定すると、429 の出方に
  // アドレスの実在が混ざりうる（#21）。読んでいなければ混ざりようがない。
  //
  // アドレス単位の上限（OtpPolicy.resendWindowMs）はアドレスを変えれば
  // 回避されるので、宛先を変えながらのメール爆撃はここでしか止まらない。
  const limited = await enforceIpRateLimit(c, "email_start");
  if (limited !== null) return limited;

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

  // challenge 単位の試行上限（OtpPolicy.maxAttempts）は、アドレスを
  // 変えながら総当たりされると効かない。IP 単位で頭を押さえる。
  const limited = await enforceIpRateLimit(c, "email_verify");
  if (limited !== null) return limited;

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
