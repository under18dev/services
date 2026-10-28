import { SELF, env } from "cloudflare:test";
import { sessionCookieName } from "@u18/contracts";
import { createIdentityDatabase, sessions, users } from "@u18/db";
import { aUser } from "@u18/testing";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { DrizzlePasskeyRepository } from "../src/infrastructure/persistence/drizzle-passkey.repository";
import { DrizzleSessionRepository } from "../src/infrastructure/persistence/drizzle-session.repository";
import { ReauthenticationPolicy } from "../src/domain/services/reauthentication";
import { resetDatabase } from "./helpers";

/**
 * `/api/me` の更新系を HTTP 越しに通す（仕様書 11.2、issue #11 / #75）。
 *
 * Origin 検証・Cookie の扱い・ステータスコードへの翻訳はこの層でしか
 * 確かめられない。再認証の判定はセッションの作成時刻に依るので、
 * 「古いセッション」は行を直接書き換えて作る。
 */

const BASE = "http://localhost";
const ORIGIN = "http://localhost:8787";
const SESSION_ID = "ses_me_routes";
const TOKEN = "session-token-for-me-routes";

const user = aUser({ username: "owner_one" });
const stranger = aUser({ username: "stranger_one" });
let cookie: string;

function db() {
  return createIdentityDatabase(env.IDENTITY_DB);
}

async function seedUser(fixture: typeof user): Promise<void> {
  await db()
    .insert(users)
    .values({
      id: fixture.id,
      username: fixture.username,
      displayName: fixture.displayName,
      primaryEmail: fixture.email,
      emailVerified: fixture.emailVerified,
    })
    .run();
}

async function seedLoggedInUser(): Promise<void> {
  await seedUser(user);
  await seedUser(stranger);

  // 本物と同じく、DB にはハッシュだけを入れる。
  await new DrizzleSessionRepository(db()).create({
    id: SESSION_ID,
    userId: user.id,
    tokenHash: await new Sha256TokenHasher().hash(TOKEN),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    authMethod: "passkey",
    userAgent: "vitest",
    ipHash: null,
  });
  cookie = `${sessionCookieName(env.ENVIRONMENT)}=${TOKEN}`;
}

/** 再認証の窓から外れたセッションにする。利用者から見れば「しばらく前のログイン」。 */
async function ageSession(): Promise<void> {
  await db()
    .update(sessions)
    .set({ createdAt: new Date(Date.now() - ReauthenticationPolicy.freshnessMs - 60 * 1000) })
    .where(eq(sessions.id, SESSION_ID))
    .run();
}

async function seedPasskey(ownerId: string, suffix: string): Promise<void> {
  await new DrizzlePasskeyRepository(db()).create({
    id: `pky_${suffix}`,
    userId: ownerId,
    credentialId: `cred-${suffix}`,
    publicKey: "cHVibGljLWtleQ",
    counter: 0,
    aaguid: null,
    deviceType: "multiDevice",
    backedUp: true,
    transports: ["internal"],
    label: suffix,
  });
}

function request(path: string, method: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { method, ...init });
}

function patchProfile(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return request("/api/me", "PATCH", {
    headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function readProfile(): Promise<Record<string, unknown>> {
  const response = await request("/api/me", "GET", { headers: { Cookie: cookie } });
  return (await response.json()) as Record<string, unknown>;
}

describe("PATCH /api/me", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedLoggedInUser();
  });

  it("displayName と username を変更でき、GET /api/me に反映される", async () => {
    const response = await patchProfile({ displayName: "新しい名前", username: "owner_two" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      displayName: "新しい名前",
      username: "owner_two",
    });
    expect(await readProfile()).toMatchObject({
      displayName: "新しい名前",
      username: "owner_two",
    });
  });

  it("email と status は本文に入れても無視される", async () => {
    // 受け付けない項目を 400 で教えると、「どの項目なら通るか」を総当たりで探せる。
    const response = await patchProfile({
      displayName: "表示名だけ",
      email: "attacker@example.com",
      status: "suspended",
      id: stranger.id,
    });

    expect(response.status).toBe(200);
    expect(await readProfile()).toMatchObject({
      displayName: "表示名だけ",
      email: user.email,
      status: "active",
      id: user.id,
    });
  });

  it.each([
    ["予約語", "admin"],
    ["短すぎ", "ab"],
    ["記号", "owner.two"],
  ])("%s の username は 400", async (_label, username) => {
    const response = await patchProfile({ username });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_input" });
    expect(await readProfile()).toMatchObject({ username: user.username });
  });

  it("他人が使っている username は 409", async () => {
    const response = await patchProfile({ username: stranger.username.toUpperCase() });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "conflict" });
    expect(await readProfile()).toMatchObject({ username: user.username });
  });

  it("型が違う本文は 400 で返す", async () => {
    const response = await patchProfile({ displayName: 42 });

    expect(response.status).toBe(400);
  });

  it("壊れた本文は 400 で返す（500 にしない）", async () => {
    const response = await request("/api/me", "PATCH", {
      headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/json" },
      body: "{not json",
    });

    expect(response.status).toBe(400);
  });

  it("Origin が無い PATCH を拒否する", async () => {
    const response = await request("/api/me", "PATCH", {
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "だめ" }),
    });

    // Origin 欠如を「通す」と、CSRF 対策が SameSite だけに頼ることになる。
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden" });
    expect(await readProfile()).toMatchObject({ displayName: user.displayName });
  });

  /**
   * `Origin: null` の救済が、**トークンの無い JSON API にも効いている**。
   *
   * form 側（`/login/*` `/signup/*`）は CSRF トークンが残るので、緩むのは
   * 二重の片方だけ。**ここにはトークンが無く、Origin 検証が唯一の防御**
   * である（`ui/csrf.ts` 冒頭の「既存の JSON API は isAllowedOrigin() だけで
   * 守っている」）。
   *
   * 安全だと考える根拠は **`Sec-Fetch-Site` が禁止ヘッダ名でスクリプトから
   * 書けない**ことと、**sandbox した iframe は不透明オリジンなので
   * `cross-site` になる**ことだが、**どちらもブラウザの性質で、こちらの
   * コードには無い**。#226 で踏んだのがまさに「ブラウザがこう振る舞うはず」
   * に寄りかかって確かめていなかった形なので、ここで固定する。
   */
  it("Origin: null でも Sec-Fetch-Site が same-origin なら通す", async () => {
    const response = await patchProfile(
      { displayName: "新しい名前" },
      { Origin: "null", "Sec-Fetch-Site": "same-origin" },
    );

    expect(response.status).toBe(200);
    expect(await readProfile()).toMatchObject({ displayName: "新しい名前" });
  });

  it("Origin: null で Sec-Fetch-Site が無ければ拒否する", async () => {
    // 送らないブラウザでは Origin 側で判定する。null のままは通さない。
    const response = await patchProfile({ displayName: "だめ" }, { Origin: "null" });

    expect(response.status).toBe(403);
    expect(await readProfile()).toMatchObject({ displayName: user.displayName });
  });

  it("Origin: null で Sec-Fetch-Site が cross-site なら拒否する", async () => {
    const response = await patchProfile(
      { displayName: "だめ" },
      { Origin: "null", "Sec-Fetch-Site": "cross-site" },
    );

    expect(response.status).toBe(403);
    expect(await readProfile()).toMatchObject({ displayName: user.displayName });
  });

  it("別オリジンは Sec-Fetch-Site が same-origin でも拒否する", async () => {
    // **救済は `Origin` が読めないときだけ。** 読めて食い違うなら、
    // ヘッダの自己申告より Origin を優先する。
    const response = await patchProfile(
      { displayName: "だめ" },
      { Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" },
    );

    expect(response.status).toBe(403);
    expect(await readProfile()).toMatchObject({ displayName: user.displayName });
  });

  it("別オリジンからの PATCH を拒否する", async () => {
    const response = await patchProfile(
      { displayName: "だめ" },
      { Origin: "https://evil.example" },
    );

    expect(response.status).toBe(403);
  });

  it("Cookie が無ければ 401", async () => {
    const response = await request("/api/me", "PATCH", {
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "だめ" }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthenticated" });
  });

  it("古いセッションでは username を変更できない", async () => {
    await ageSession();

    const response = await patchProfile({ username: "owner_two" });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "reauthentication_required" });
    expect(await readProfile()).toMatchObject({ username: user.username });
  });

  it("古いセッションでも displayName は変更できる", async () => {
    await ageSession();

    const response = await patchProfile({ displayName: "表示名だけ" });

    expect(response.status).toBe(200);
  });
});

describe("GET /api/me/passkeys", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedLoggedInUser();
    await seedPasskey(user.id, "mine");
    await seedPasskey(stranger.id, "theirs");
  });

  it("自分の認証器だけを返す", async () => {
    const response = await request("/api/me/passkeys", "GET", { headers: { Cookie: cookie } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { passkeys: { id: string; label: string }[] };
    expect(body.passkeys.map((p) => p.id)).toEqual(["pky_mine"]);
    expect(body.passkeys[0]).toMatchObject({ label: "mine", deviceType: "multiDevice" });
  });

  it("Credential ID と公開鍵を応答に載せない", async () => {
    const response = await request("/api/me/passkeys", "GET", { headers: { Cookie: cookie } });

    // 公開鍵は検証に要らず、Credential ID は他サイトの記録と突き合わせると
    // 同じ認証器だと分かる識別子になる（仕様書 9 Privacy）。
    const text = await response.text();
    expect(text).not.toContain("cred-mine");
    expect(text).not.toContain("cHVibGljLWtleQ");
    expect(text).not.toContain("publicKey");
  });

  it("Cookie が無ければ 401", async () => {
    const response = await request("/api/me/passkeys", "GET");

    expect(response.status).toBe(401);
  });
});

describe("DELETE /api/me/passkeys/:id", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedLoggedInUser();
    await seedPasskey(user.id, "mine");
    await seedPasskey(stranger.id, "theirs");
  });

  function remove(id: string, headers: Record<string, string> = {}): Promise<Response> {
    return request(`/api/me/passkeys/${id}`, "DELETE", {
      headers: { Origin: ORIGIN, Cookie: cookie, ...headers },
    });
  }

  it("自分の最後の 1 本を削除できる", async () => {
    const response = await remove("pky_mine");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, remaining: 0 });

    const list = await request("/api/me/passkeys", "GET", { headers: { Cookie: cookie } });
    expect(await list.json()).toEqual({ passkeys: [] });
  });

  it("他人の認証器は 404 で、行も消えない", async () => {
    const response = await remove("pky_theirs");

    expect(response.status).toBe(404);
    expect(await new DrizzlePasskeyRepository(db()).findById("pky_theirs")).not.toBeNull();
  });

  it("Origin が無い DELETE を拒否する", async () => {
    const response = await request("/api/me/passkeys/pky_mine", "DELETE", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(403);
    expect(await new DrizzlePasskeyRepository(db()).findById("pky_mine")).not.toBeNull();
  });

  it("Cookie が無ければ 401", async () => {
    const response = await request("/api/me/passkeys/pky_mine", "DELETE", {
      headers: { Origin: ORIGIN },
    });

    expect(response.status).toBe(401);
  });

  it("古いセッションでは削除できない", async () => {
    await ageSession();

    const response = await remove("pky_mine");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "reauthentication_required" });
    expect(await new DrizzlePasskeyRepository(db()).findById("pky_mine")).not.toBeNull();
  });
});
