import { Hono, type Context } from "hono";
import { z } from "zod";
import type { WebAuthnResponseJson } from "../../application/ports/webauthn.port";
import type { UseCaseError } from "../../application/use-cases/types";
import { isAllowedOrigin } from "./origin";
import { problem, statusForUseCaseError } from "./problem";
import { buildSessionCookie, readSessionCookie } from "./session-cookie";
import type { AppBindings } from "./types";

/**
 * パスキー（WebAuthn）の登録・ログイン（仕様書 6.1 / 8.1）。
 *
 * `/api/auth/passkeys` 配下にマウントされる。4 本とも状態を変える POST なので、
 * options の発行も含めて Origin を検証する（Challenge 行が増えるのも状態変化）。
 * Origin / RP ID / 署名の検証そのものは Application の WebAuthn Port が行い、
 * ここは入出力の形だけを扱う。
 */
export const passkeyRoutes = new Hono<AppBindings>();

/**
 * ブラウザが返す credential の JSON。
 *
 * `id` 以外は素通しする。中身の検証はライブラリ（Port 実装）の仕事で、
 * ここで形を縛ると WebAuthn の拡張が増えるたびに壊れる。
 */
const credentialResponseSchema = z.looseObject({ id: z.string().min(1) });

const registerVerifySchema = z.object({
  challengeId: z.string().min(1),
  response: credentialResponseSchema,
  label: z.string().min(1).max(64).optional(),
});

const loginVerifySchema = z.object({
  challengeId: z.string().min(1),
  response: credentialResponseSchema,
});

passkeyRoutes.post("/register/options", async (c) => {
  if (!isAllowedOrigin(c)) return problem(c, 403, "forbidden", "origin not allowed");

  const token = readSessionCookie(c);
  // 登録はログイン済みの利用者が自分の認証器を足す操作。未認証で通すと
  // 他人のアカウントに認証器を追加できてしまう。
  if (token === null) return problem(c, 401, "unauthenticated", "no session");

  const result = await c.get("container").useCases.passkeyRegisterOptions.execute({
    sessionToken: token,
  });
  if (!result.ok) return fromUseCaseError(c, result.error);

  return c.json(result.value);
});

passkeyRoutes.post("/register/verify", async (c) => {
  if (!isAllowedOrigin(c)) return problem(c, 403, "forbidden", "origin not allowed");

  const token = readSessionCookie(c);
  if (token === null) return problem(c, 401, "unauthenticated", "no session");

  const body = await readJson(c.req.raw);
  const parsed = registerVerifySchema.safeParse(body);
  if (!parsed.success) return problem(c, 400, "invalid_input", "malformed registration response");

  const result = await c.get("container").useCases.passkeyRegisterVerify.execute({
    sessionToken: token,
    challengeId: parsed.data.challengeId,
    response: parsed.data.response as WebAuthnResponseJson,
    label: parsed.data.label ?? null,
  });
  if (!result.ok) return fromUseCaseError(c, result.error);

  return c.json(result.value);
});

passkeyRoutes.post("/login/options", async (c) => {
  if (!isAllowedOrigin(c)) return problem(c, 403, "forbidden", "origin not allowed");

  // 入力は受け取らない。誰のログインかを問わないことで、応答の差から
  // アカウントの実在を推測されないようにする（仕様書 9）。
  const result = await c.get("container").useCases.passkeyLoginOptions.execute();
  if (!result.ok) return fromUseCaseError(c, result.error);

  return c.json(result.value);
});

passkeyRoutes.post("/login/verify", async (c) => {
  if (!isAllowedOrigin(c)) return problem(c, 403, "forbidden", "origin not allowed");

  const body = await readJson(c.req.raw);
  const parsed = loginVerifySchema.safeParse(body);
  if (!parsed.success) return problem(c, 400, "invalid_input", "malformed authentication response");

  const result = await c.get("container").useCases.passkeyLoginVerify.execute({
    challengeId: parsed.data.challengeId,
    response: parsed.data.response as WebAuthnResponseJson,
    userAgent: c.req.header("User-Agent") ?? null,
    // 生 IP はここから先へ出さない。保存されるのはハッシュだけ（仕様書 9 Privacy）。
    ip: c.req.header("CF-Connecting-IP") ?? null,
  });
  if (!result.ok) return fromUseCaseError(c, result.error);

  const { session, token } = result.value;
  c.header("Set-Cookie", buildSessionCookie(c.env, token, session.expiresAt), { append: true });

  return c.json({ userId: session.userId, expiresAt: session.expiresAt.toISOString() });
});

/** 壊れた JSON を 500 にしない。Hono の `c.req.json()` は本文が不正だと投げる。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function fromUseCaseError(c: Context<AppBindings>, error: UseCaseError): Response {
  return problem(c, statusForUseCaseError(error.code), error.code, error.message);
}
