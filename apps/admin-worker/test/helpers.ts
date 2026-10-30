import { env } from "cloudflare:test";
import { createApp } from "../src/presentation/http/app";
import type { ApprovalRepository } from "../src/application/ports/approval.repository";
import { createFakeIdp } from "./fake-idp";

export const ORIGIN = env.ADMIN_ORIGIN;

/** `isApproved` / `isSuperApprover` を固定値で答える fake。D1 を立てずにガードの分岐だけを見る。 */
export function fakeApprovals(
  approvedSubs: readonly string[],
  superSubs: readonly string[] = [],
): ApprovalRepository {
  return {
    isApproved: async (sub) => approvedSubs.includes(sub),
    isSuperApprover: async (sub) => superSubs.includes(sub),
  };
}

/** Response の Set-Cookie をすべて取り出し、次の Request へ渡す `Cookie` 文字列を作る。 */
export function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
}

export function executionContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
}

/**
 * OIDC のログイン往復を済ませ、セッション Cookie を返す（#382 以降の
 * 画面テストが要るので `app.test.ts` から共有へ切り出した）。
 *
 * **ここで承認済みにするとは限らない。** `approvals` 次第で `/pending`
 * に落ちる状態も作れる——呼び出し側がどちらを見たいかを選ぶ。
 *
 * **既定で `acr: "passkey"` を乗せる**（#390 決定 8）。`/callback` が
 * `REQUIRED_ACR` を見るようになったので、乗せないと**すべての画面テストが
 * ログインの時点で弾かれる**——ここは「Passkey で入った管理者」を
 * 代表させる既定値で、acr 自体の拒否を見たいテスト（`app.test.ts`）だけ
 * `acr` を明示的に外す。
 */
export async function loginAs(
  sub: string,
  approvals: ApprovalRepository,
  overrides: Parameters<typeof createApp>[0] = {},
  acr: string | undefined = "passkey",
): Promise<string> {
  const idp = await createFakeIdp(env.AUTH_ISSUER);
  const loginApp = createApp({ ...overrides, fetcher: idp.fetcherReturning("unused"), approvals });
  const loginResponse = await loginApp.fetch(
    new Request(`${ORIGIN}/login`),
    env,
    executionContext(),
  );
  const authorizeUrl = new URL(loginResponse.headers.get("Location") ?? "");
  const state = authorizeUrl.searchParams.get("state")!;
  const nonce = authorizeUrl.searchParams.get("nonce")!;
  const loginStateCookie = cookieHeaderFrom(loginResponse);

  const idToken = await idp.signIdToken({
    sub,
    aud: env.OIDC_CLIENT_ID,
    nonce,
    ...(acr === undefined ? {} : { acr }),
  });
  const callbackApp = createApp({
    ...overrides,
    fetcher: idp.fetcherReturning(idToken),
    approvals,
  });
  const callbackResponse = await callbackApp.fetch(
    new Request(`${ORIGIN}/callback?code=c1&state=${state}`, {
      headers: { Cookie: loginStateCookie },
    }),
    env,
    executionContext(),
  );
  return cookieHeaderFrom(callbackResponse);
}
