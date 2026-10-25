import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  createIdentityDatabase,
  oauthClients,
  oauthRedirectUris,
  sessions,
  signingKeyMetadata,
  users,
} from "@u18/db";
import { newClientId, newSessionId } from "@u18/domain";
import { aUser } from "@u18/testing";
import { exportJWK, generateKeyPair } from "jose";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { createApp } from "../src/presentation/http/app";

/**
 * Code Flow を HTTP 越しに通すための下ごしらえ（#15 / #16 / #19）。
 *
 * ここに置いてあるのは「本物と同じ行を作る」だけの処理で、判断は 1 つも
 * していない。認可コードそのものは **UseCase に作らせる**（`/oauth/authorize`
 * を実際に叩く）——コードの行をテストから直接差し込むと、authorize が
 * 保存しそこねた列があってもテストが通ってしまう。
 */

export const BASE = "http://localhost";
/** `vitest.config.ts` の `ISSUER` と揃えること。Origin 検証がこれを見る。 */
export const ORIGIN = "http://localhost:8787";

export const CONFIDENTIAL_CLIENT_ID = "u18-first-party";
export const CONFIDENTIAL_SECRET = "test-only-secret";
export const PUBLIC_CLIENT_ID = "u18-third-party";
export const REDIRECT_URI = "https://app.example/cb";

export const db = () => createIdentityDatabase(env.IDENTITY_DB);

export type SeededClient = {
  readonly id: string;
  readonly clientId: string;
  readonly redirectUri: string;
};

export async function seedClient(options: {
  readonly clientId: string;
  readonly clientType: "confidential" | "public";
  readonly isFirstParty: boolean;
  readonly secret?: string;
  readonly redirectUris?: readonly string[];
  readonly allowedScopes?: string;
  readonly disabledAt?: Date | null;
}): Promise<SeededClient> {
  const id = newClientId();
  const redirectUris = options.redirectUris ?? [REDIRECT_URI];

  await db()
    .insert(oauthClients)
    .values({
      id,
      clientId: options.clientId,
      name: `${options.clientId} の表示名`,
      clientType: options.clientType,
      clientSecretHash:
        options.secret === undefined ? null : await new Sha256TokenHasher().hash(options.secret),
      allowedScopes: options.allowedScopes ?? "openid profile email",
      isFirstParty: options.isFirstParty,
      logoUrl: null,
      disabledAt: options.disabledAt ?? null,
    })
    .run();

  for (const uri of redirectUris) {
    await db().insert(oauthRedirectUris).values({ id: newClientId(), clientId: id, uri }).run();
  }

  return { id, clientId: options.clientId, redirectUri: redirectUris[0] ?? REDIRECT_URI };
}

/** 既定の 2 クライアント（first-party / third-party）を入れる。 */
export async function seedDefaultClients(): Promise<{
  readonly firstParty: SeededClient;
  readonly thirdParty: SeededClient;
}> {
  return {
    firstParty: await seedClient({
      clientId: CONFIDENTIAL_CLIENT_ID,
      clientType: "confidential",
      isFirstParty: true,
      secret: CONFIDENTIAL_SECRET,
    }),
    thirdParty: await seedClient({
      clientId: PUBLIC_CLIENT_ID,
      clientType: "public",
      isFirstParty: false,
    }),
  };
}

export type SeededUser = {
  readonly userId: string;
  readonly sessionId: string;
  /** セッション Cookie に入れる平文トークン。 */
  readonly sessionToken: string;
  readonly authTime: Date;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
};

/**
 * ログイン済みの利用者を作る。
 *
 * `sessions` へ直接行を入れる。OTP を本当に通すと 1 テストあたり 2 往復
 * 増えるうえ、確かめたいのは認可側であってログイン側ではない
 * （ログイン経路そのものは `login.ui.test.ts` が通している）。
 */
export async function seedLoggedInUser(
  options: { readonly authTime?: Date; readonly status?: "active" | "suspended" } = {},
): Promise<SeededUser> {
  const user = aUser({ status: options.status ?? "active" });
  const authTime = options.authTime ?? new Date();
  const sessionToken = `session-token-${newSessionId()}`;
  const sessionId = newSessionId();

  await db()
    .insert(users)
    .values({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      primaryEmail: user.email,
      emailVerified: user.emailVerified,
      status: user.status,
    })
    .run();

  await db()
    .insert(sessions)
    .values({
      id: sessionId,
      userId: user.id,
      tokenHash: await new Sha256TokenHasher().hash(sessionToken),
      expiresAt: new Date(authTime.getTime() + 12 * 60 * 60 * 1000),
      authMethod: "email_otp",
      lastSeenAt: authTime,
      userAgent: "vitest",
      ipHash: null,
      // `auth_time` はセッションの作成時刻（AuthorizeRequestUseCase を参照）。
      createdAt: authTime,
    })
    .run();

  return {
    userId: user.id,
    sessionId,
    sessionToken,
    authTime,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
  };
}

/** セッション Cookie のヘッダ値。`ENVIRONMENT=development` なので接頭辞なし。 */
export function sessionCookie(user: SeededUser): string {
  return `u18_session=${user.sessionToken}`;
}

export type SigningKey = {
  readonly kid: string;
  readonly publicJwk: Record<string, unknown>;
  /** `SIGNING_KEY_JWK` に入れる秘密鍵 JWK の JSON。 */
  readonly privateJwkJson: string;
};

/**
 * ID Token の署名鍵を入れる。
 *
 * 公開鍵は `signing_key_metadata` へ、秘密鍵は返り値として呼び出し側へ渡す。
 * 秘密鍵は Workers Secret から読まれるが、`SELF.fetch` は
 * `vitest.config.ts` の固定 binding を使うので後から注入できない
 * （`config-resilience.test.ts` と同じ事情）。そのため OAuth のテストは
 * `createApp()` を直接叩き、env を `appEnv()` で組み立てる。
 */
export async function seedSigningKey(kid = "test-key-1"): Promise<SigningKey> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const meta = { alg: "ES256", use: "sig", kid };
  const publicJwk = { ...(await exportJWK(publicKey)), ...meta };
  const privateJwk = { ...(await exportJWK(privateKey)), ...meta };

  await db()
    .insert(signingKeyMetadata)
    .values({
      kid,
      algorithm: "ES256",
      publicJwk: JSON.stringify(publicJwk),
      activeFrom: new Date(Date.now() - 60_000),
      activeUntil: null,
      retiresAt: null,
    })
    .run();

  return { kid, publicJwk, privateJwkJson: JSON.stringify(privateJwk) };
}

export type PkcePair = {
  readonly verifier: string;
  readonly challenge: string;
};

/** RFC 7636 の `code_verifier` と S256 の `code_challenge` を作る。 */
export async function createPkcePair(): Promise<PkcePair> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = base64Url(bytes);

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * テスト用の `Env`。
 *
 * `SELF.fetch` を使わないのは、署名鍵の Secret を注入できないため
 * （`config-resilience.test.ts` の「/health と Discovery は〜」と同じ事情）。
 * D1 binding は本物をそのまま渡すので、検証しているのは実 D1 上の挙動である。
 */
export function appEnv(signingKey?: SigningKey): Env {
  return {
    ...env,
    SIGNING_KEY_JWK: signingKey?.privateJwkJson,
    SIGNING_KEY_KID: signingKey?.kid,
  } as unknown as Env;
}

/** 1 リクエストを Worker へ通す。リダイレクトは追わない。 */
export async function fetchApp(request: Request, workerEnv: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await createApp().fetch(request, workerEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * テストごとに重複しない送信元 IP を配る。
 *
 * OAuth の経路には IP 単位のレート制限が掛かっている（#21）。
 * `CF-Connecting-IP` を付けないと全テストが `"unknown-ip"` の 1 つの枠を
 * 共有し、**テストを足しただけで無関係なテストが 429 で落ちる**。
 * 実際そうなった（`/oauth/authorize` は 30 回 / 60 秒）。
 *
 * 呼び出しごとに別の IP を配ることで、順序にも本数にも依存しなくなる。
 * 本番ではブラウザごと・サーバごとに別 IP なので、こちらのほうが実態に近い。
 */
let nextProbeIp = 0;
export function freshClientIp(): string {
  nextProbeIp += 1;
  return `198.51.100.${nextProbeIp % 254}`;
}

export type AuthorizeQuery = Record<string, string | undefined>;

/** `/oauth/authorize` を GET する。 */
export function authorize(
  query: AuthorizeQuery,
  options: { readonly cookie?: string; readonly env?: Env } = {},
): Promise<Response> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, value);
  }
  const headers: Record<string, string> = { "CF-Connecting-IP": freshClientIp() };
  if (options.cookie !== undefined) headers["Cookie"] = options.cookie;
  const request = new Request(`${BASE}/oauth/authorize?${params.toString()}`, { headers });
  return fetchApp(request, options.env ?? appEnv());
}

/** 同意画面の送信。CSRF トークンと Origin はログイン画面と同じ扱い。 */
export function consent(
  fields: Record<string, string | undefined>,
  options: { readonly cookie: string; readonly env?: Env; readonly origin?: string },
): Promise<Response> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.set(key, value);
  }
  const request = new Request(`${BASE}/oauth/consent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: options.cookie,
      Origin: options.origin ?? ORIGIN,
      "CF-Connecting-IP": freshClientIp(),
    },
    body: form.toString(),
  });
  return fetchApp(request, options.env ?? appEnv());
}

/** 既定のパラメータを埋めた認可要求。 */
export function authorizeQuery(overrides: AuthorizeQuery = {}): AuthorizeQuery {
  return {
    client_id: CONFIDENTIAL_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid profile email",
    state: "state-123",
    code_challenge_method: "S256",
    ...overrides,
  };
}

/** `Location` から認可応答のクエリを読む。 */
export function locationParams(response: Response): URLSearchParams {
  const location = response.headers.get("Location");
  if (location === null) throw new Error("Location ヘッダが無い");
  return new URL(location, BASE).searchParams;
}

export type TokenRequestBody = Record<string, string | undefined>;

/** `POST /oauth/token`。認証方式は呼び出し側が選ぶ。 */
export function tokenRequest(
  body: TokenRequestBody,
  options: {
    readonly basic?: { id: string; secret: string };
    readonly env?: Env;
  } = {},
): Promise<Response> {
  return fetchApp(tokenHttpRequest(body, options.basic), options.env ?? appEnv());
}

/**
 * `/oauth/userinfo`（#17）。
 *
 * メソッドを選べるようにしてあるのは、仕様書 5.2 が GET と POST の
 * 両方を求めているため。Bearer は常にヘッダから渡す（実装がクエリや
 * 本文から読まないことを、この helper の形自体が示している）。
 */
export function userinfoRequest(
  accessToken: string | null,
  options: {
    readonly method?: "GET" | "POST";
    readonly env?: Env;
    /** `Bearer ` 接頭辞ごと差し替えたいとき用。 */
    readonly rawAuthorization?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.rawAuthorization !== undefined) {
    headers["Authorization"] = options.rawAuthorization;
  } else if (accessToken !== null) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const request = new Request(`${BASE}/oauth/userinfo`, {
    method: options.method ?? "GET",
    headers,
  });
  return fetchApp(request, options.env ?? appEnv());
}

/** `POST /oauth/revoke`（#17）。認証方式は `/oauth/token` と同じ。 */
export function revokeRequest(
  body: Record<string, string | undefined>,
  options: {
    readonly basic?: { id: string; secret: string };
    readonly env?: Env;
  } = {},
): Promise<Response> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) form.set(key, value);
  }

  const headers: Record<string, string> = {
    "CF-Connecting-IP": freshClientIp(),
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (options.basic !== undefined) {
    const encoded = `${encodeURIComponent(options.basic.id)}:${encodeURIComponent(options.basic.secret)}`;
    headers["Authorization"] = `Basic ${btoa(encoded)}`;
  }

  const request = new Request(`${BASE}/oauth/revoke`, {
    method: "POST",
    headers,
    body: form.toString(),
  });
  return fetchApp(request, options.env ?? appEnv());
}

/** 並列実行のために、要求の組み立てと送信を分けておく（#19）。 */
export function tokenHttpRequest(
  body: TokenRequestBody,
  basic?: { id: string; secret: string },
): Request {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) form.set(key, value);
  }

  const headers: Record<string, string> = {
    "CF-Connecting-IP": freshClientIp(),
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (basic !== undefined) {
    // RFC 6749 §2.3.1: form-urlencode してから base64。
    const encoded = `${encodeURIComponent(basic.id)}:${encodeURIComponent(basic.secret)}`;
    headers["Authorization"] = `Basic ${btoa(encoded)}`;
  }

  return new Request(`${BASE}/oauth/token`, { method: "POST", headers, body: form.toString() });
}
