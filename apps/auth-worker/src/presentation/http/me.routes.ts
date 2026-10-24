import { Hono, type Context } from "hono";
import { z } from "zod";
import type { UseCaseError } from "../../application/use-cases/types";
import type { User } from "../../domain/entities/user";
import { buildClearedSessionCookie, readSessionCookie } from "./session-cookie";
import type { AppBindings } from "./types";
import { isAllowedOrigin } from "./origin";
import { problem, statusForUseCaseError } from "./problem";

/**
 * 自分自身に関する API（仕様書 8.1）。
 *
 * userId をパスやボディで受け取らない。対象は常に Cookie のセッションから導く。
 *
 * 状態を変える経路（PATCH /me, DELETE /me/sessions/:id, DELETE /me/passkeys/:id）は
 * すべて `isAllowedOrigin` を通す。CSRF 対策の手段を Origin 検証に統一して、
 * 別途 CSRF トークンを導入していないのは、
 * - Origin は fail-closed（ヘッダが無ければ拒否）で、トークンのように
 *   「発行・保管・失効」の経路を増やさない
 * - セッション Cookie は `__Host-` + SameSite=Lax で、そもそもクロスサイトの
 *   PATCH / DELETE には付かない。Origin 検証はその二重化である
 * - 既存の更新系（logout / セッション失効 / パスキー登録）がすべて同じ判定を
 *   使っており、ここだけ別方式にすると「どれが守られているか」が読めなくなる
 * という理由による（仕様書 9 CSRF、issue #11）。
 */
export const meRoutes = new Hono<AppBindings>();

/** GET と PATCH で同じ形を返す。応答の項目を 1 か所で決めるため。 */
function toProfileJson(user: User) {
  const props = user.snapshot();
  return {
    id: props.id,
    username: props.username,
    displayName: props.displayName,
    email: props.email,
    emailVerified: props.emailVerified,
    status: props.status,
    createdAt: props.createdAt.toISOString(),
  };
}

/**
 * 更新できる項目はこの 2 つだけ。
 *
 * zod は未知のキーを落とすので、`email` / `status` / `id` を本文に混ぜられても
 * UseCase には届かない。エラーにせず黙って無視するのは、受け付けない項目を
 * 400 で教えると「どの項目なら通るか」を総当たりで探せるため。
 */
const updateProfileSchema = z.object({
  displayName: z.string().optional(),
  username: z.string().optional(),
});

meRoutes.get("/me", async (c) => {
  const token = readSessionCookie(c);
  if (token === null) return problem(c, 401, "unauthenticated", "no session");

  const container = c.get("container");
  const result = await container.useCases.getSession.execute({ sessionToken: token });
  if (!result.ok) return fromUseCaseError(c, result.error);
  if (result.value === null) return problem(c, 401, "unauthenticated", "session is not valid");

  const user = await container.repositories.users.findById(result.value.userId);
  if (user === null) return problem(c, 401, "unauthenticated", "session is not valid");

  return c.json(toProfileJson(user));
});

/**
 * プロフィールの変更（issue #11）。
 *
 * username の変更には直近の認証を要求する。足りなければ
 * `reauthentication_required`（403）を返すので、クライアントは
 * ログインし直してから再送する（domain/services/reauthentication.ts）。
 */
meRoutes.patch("/me", async (c) => {
  const token = readSessionCookie(c);
  if (token === null) return problem(c, 401, "unauthenticated", "no session");

  if (!isAllowedOrigin(c)) {
    return problem(c, 403, "forbidden", "origin not allowed");
  }

  const parsed = updateProfileSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return problem(c, 400, "invalid_input", "malformed profile update");

  const result = await c.get("container").useCases.updateProfile.execute({
    sessionToken: token,
    displayName: parsed.data.displayName,
    username: parsed.data.username,
  });
  if (!result.ok) return fromUseCaseError(c, result.error);

  return c.json(toProfileJson(result.value.user));
});

meRoutes.get("/me/sessions", async (c) => {
  const token = readSessionCookie(c);
  if (token === null) return problem(c, 401, "unauthenticated", "no session");

  const container = c.get("container");
  const result = await container.useCases.listSessions.execute({ sessionToken: token });
  if (!result.ok) return fromUseCaseError(c, result.error);
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
  if (!isAllowedOrigin(c)) {
    return problem(c, 403, "forbidden", "origin not allowed");
  }

  const container = c.get("container");
  const result = await container.useCases.revokeSession.execute({
    sessionToken: token,
    targetSessionId: c.req.param("id"),
  });
  if (!result.ok) return fromUseCaseError(c, result.error);

  // 自分自身のセッションを消した場合**だけ** Cookie を落とす。
  // revoked だけで判断すると、別端末を失効させた操作で自分がログアウトされる。
  if (result.value.revoked && result.value.self) {
    c.header("Set-Cookie", buildClearedSessionCookie(c.env), { append: true });
  }
  return c.json({ revoked: result.value.revoked, self: result.value.self });
});

/**
 * 登録済み認証器の一覧（issue #75）。
 *
 * `credentialId` と `publicKey` は返さない。どちらも認証の成立には要らず、
 * Credential ID は他サイトの記録と突き合わせると同じ認証器だと分かる
 * 識別子になる（仕様書 9 Privacy）。利用者が「どれを消すか」を選ぶには
 * 内部 ID・ラベル・種別・日時で足りる。
 */
meRoutes.get("/me/passkeys", async (c) => {
  const token = readSessionCookie(c);
  if (token === null) return problem(c, 401, "unauthenticated", "no session");

  const result = await c.get("container").useCases.listPasskeys.execute({ sessionToken: token });
  if (!result.ok) return fromUseCaseError(c, result.error);
  if (result.value === null) return problem(c, 401, "unauthenticated", "session is not valid");

  return c.json({
    passkeys: result.value.map((passkey) => ({
      id: passkey.id,
      label: passkey.label,
      deviceType: passkey.deviceType,
      createdAt: passkey.createdAt.toISOString(),
      lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
    })),
  });
});

/**
 * 認証器を 1 本外す（issue #75）。
 *
 * 最後の 1 本でも外せる。理由は DeletePasskeyUseCase のコメントを参照。
 * 残本数は応答に含めるので、UI は「パスキーが無くなった」ことを案内できる。
 */
meRoutes.delete("/me/passkeys/:id", async (c) => {
  const token = readSessionCookie(c);
  if (token === null) return problem(c, 401, "unauthenticated", "no session");

  if (!isAllowedOrigin(c)) {
    return problem(c, 403, "forbidden", "origin not allowed");
  }

  const result = await c.get("container").useCases.deletePasskey.execute({
    sessionToken: token,
    passkeyId: c.req.param("id"),
  });
  if (!result.ok) return fromUseCaseError(c, result.error);

  return c.json({ deleted: result.value.deleted, remaining: result.value.remaining });
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
