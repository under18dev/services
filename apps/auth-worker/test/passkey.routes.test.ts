import { SELF, env } from "cloudflare:test";
import { sessionCookieName } from "@u18/contracts";
import { createIdentityDatabase, users } from "@u18/db";
import { aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { DrizzleSessionRepository } from "../src/infrastructure/persistence/drizzle-session.repository";
import { TestAuthenticator } from "./fakes.passkey";
import { resetDatabase } from "./helpers";

/**
 * パスキー API を HTTP 越しに通す（仕様書 11.2）。
 *
 * 本物の認証器（P-256 の鍵で実際に署名する）を使い、Challenge の発行から
 * セッション Cookie の発行までを 1 本で確かめる。Origin 検証と Cookie の
 * 扱いはこの層でしか検証できない。
 */

const BASE = "http://localhost";
const ORIGIN = "http://localhost:8787";
const RP_ID = "localhost";

const user = aUser();
let sessionCookie: string;

async function seedLoggedInUser(): Promise<void> {
  const db = createIdentityDatabase(env.IDENTITY_DB);
  await db
    .insert(users)
    .values({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      primaryEmail: user.email,
      emailVerified: user.emailVerified,
    })
    .run();

  // 本物と同じく、DB にはハッシュだけを入れる。
  const token = "session-token-for-passkey-routes";
  await new DrizzleSessionRepository(db).create({
    id: "ses_passkey_routes",
    userId: user.id,
    tokenHash: await new Sha256TokenHasher().hash(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    authMethod: "email_otp",
    userAgent: "vitest",
    ipHash: null,
  });
  sessionCookie = `${sessionCookieName(env.ENVIRONMENT)}=${token}`;
}

function post(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { method: "POST", ...init });
}

function authed(path: string, body?: unknown): Promise<Response> {
  return post(path, {
    headers: {
      Origin: ORIGIN,
      Cookie: sessionCookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function anonymous(path: string, body?: unknown): Promise<Response> {
  return post(path, {
    headers: {
      Origin: ORIGIN,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type OptionsResponse = { challengeId: string; options: { challenge: string } };

describe("パスキー API: Origin 検証", () => {
  const paths = [
    "/api/auth/passkeys/register/options",
    "/api/auth/passkeys/register/verify",
    "/api/auth/passkeys/login/options",
    "/api/auth/passkeys/login/verify",
  ];

  it.each(paths)("%s は Origin が無ければ 403", async (path) => {
    // 更新系なので fail-closed。options 発行も Challenge 行を作る状態変更。
    const response = await post(path);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden" });
  });

  it.each(paths)("%s は別オリジンを拒否する", async (path) => {
    const response = await post(path, { headers: { Origin: "https://evil.example" } });
    expect(response.status).toBe(403);
  });
});

describe("パスキー登録 API", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedLoggedInUser();
  });

  it.each([
    ["/api/auth/passkeys/register/options", undefined],
    ["/api/auth/passkeys/register/verify", { challengeId: "wac_x", response: { id: "c" } }],
  ])("%s はログインしていなければ 401", async (path, body) => {
    const response = await anonymous(path, body);
    expect(response.status).toBe(401);
  });

  it("壊れた本文は 400 で返す（500 にしない）", async () => {
    const response = await post("/api/auth/passkeys/register/verify", {
      headers: { Origin: ORIGIN, Cookie: sessionCookie, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  it("登録したパスキーでログインし、セッション Cookie を受け取れる", async () => {
    const authenticator = await TestAuthenticator.create();

    const optionsResponse = await authed("/api/auth/passkeys/register/options");
    expect(optionsResponse.status).toBe(200);
    const registration = (await optionsResponse.json()) as OptionsResponse;

    const verifyResponse = await authed("/api/auth/passkeys/register/verify", {
      challengeId: registration.challengeId,
      label: "iPhone",
      response: await authenticator.attest({
        challenge: registration.options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
      }),
    });
    expect(verifyResponse.status).toBe(200);

    // --- ここからログイン。Cookie は使わない。 ---
    const loginOptions = (await (
      await anonymous("/api/auth/passkeys/login/options")
    ).json()) as OptionsResponse;

    const loginResponse = await anonymous("/api/auth/passkeys/login/verify", {
      challengeId: loginOptions.challengeId,
      response: await authenticator.assert({
        challenge: loginOptions.options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
        counter: 1,
      }),
    });

    expect(loginResponse.status).toBe(200);
    expect(await loginResponse.json()).toMatchObject({ userId: user.id });

    const setCookie = loginResponse.headers.get("Set-Cookie");
    expect(setCookie).toContain(`${sessionCookieName(env.ENVIRONMENT)}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");

    // 発行された Cookie で実際に自分の情報が引ける。
    const issued = setCookie?.split(";")[0] ?? "";
    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: issued } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: user.id });
  });
});

describe("パスキーログイン API の失敗応答", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedLoggedInUser();
  });

  async function startLogin(): Promise<OptionsResponse> {
    return (await (await anonymous("/api/auth/passkeys/login/options")).json()) as OptionsResponse;
  }

  it("未登録の Credential でも 401 以外の手掛かりを返さない", async () => {
    // 「そんな認証器は知らない」と「署名が違う」を区別させない（仕様書 9）。
    const stranger = await TestAuthenticator.create("unknown-credential");
    const login = await startLogin();

    const response = await anonymous("/api/auth/passkeys/login/verify", {
      challengeId: login.challengeId,
      response: await stranger.assert({
        challenge: login.options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
        counter: 1,
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "unauthenticated",
      message: "passkey authentication failed",
    });
  });

  it("同じ Challenge を 2 回使ったログインを拒否する", async () => {
    const authenticator = await TestAuthenticator.create();
    const registration = (await (
      await authed("/api/auth/passkeys/register/options")
    ).json()) as OptionsResponse;
    await authed("/api/auth/passkeys/register/verify", {
      challengeId: registration.challengeId,
      response: await authenticator.attest({
        challenge: registration.options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
      }),
    });

    const login = await startLogin();
    const body = {
      challengeId: login.challengeId,
      response: await authenticator.assert({
        challenge: login.options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
        counter: 1,
      }),
    };

    const first = await anonymous("/api/auth/passkeys/login/verify", body);
    const second = await anonymous("/api/auth/passkeys/login/verify", body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });
});
