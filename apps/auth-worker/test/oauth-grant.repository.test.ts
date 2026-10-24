import { env } from "cloudflare:test";
import { createIdentityDatabase, oauthAuthorizationCodes, users } from "@u18/db";
import { newCodeId, newGrantId, newSessionId } from "@u18/domain";
import { aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { DrizzleAuthorizationCodeRepository } from "../src/infrastructure/persistence/drizzle-authorization-code.repository";
import { DrizzleOAuthGrantRepository } from "../src/infrastructure/persistence/drizzle-oauth-grant.repository";
import { DrizzleOAuthTokenRepository } from "../src/infrastructure/persistence/drizzle-oauth-token.repository";
import { resetDatabase } from "./helpers";
import { seedClient, type SeededClient } from "./helpers.oauth";

/**
 * 同意・トークン・認可コードの Repository（#15 / #16）。
 *
 * HTTP 越しのテストでは通らない枝——同意の scope 和集合、取り消しの冪等性、
 * セッション単位の連鎖失効——をここで固定する。
 */

const database = () => createIdentityDatabase(env.IDENTITY_DB);

let client: SeededClient;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  client = await seedClient({
    clientId: "repo-test-client",
    clientType: "public",
    isFirstParty: false,
  });

  const user = aUser();
  userId = user.id;
  await database()
    .insert(users)
    .values({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      primaryEmail: user.email,
      emailVerified: true,
    })
    .run();
});

describe("DrizzleOAuthGrantRepository", () => {
  const repository = () => new DrizzleOAuthGrantRepository(database());

  it("同じ (user, client) を 2 度記録しても行は 1 つ", async () => {
    const at = new Date();
    await repository().record({
      id: newGrantId(),
      userId,
      clientId: client.id,
      grantedScopes: "openid",
      at,
    });
    const second = await repository().record({
      id: newGrantId(),
      userId,
      clientId: client.id,
      grantedScopes: "openid profile",
      at,
    });

    const found = await repository().find(userId, client.id);
    expect(found?.id).toBe(second.id);
  });

  it("既存の同意に scope を足すときは和集合にする", async () => {
    const at = new Date();
    await repository().record({
      id: newGrantId(),
      userId,
      clientId: client.id,
      grantedScopes: "openid email",
      at,
    });
    await repository().record({
      id: newGrantId(),
      userId,
      clientId: client.id,
      grantedScopes: "openid profile",
      at,
    });

    const found = await repository().find(userId, client.id);
    // 「新しい要求で上書き」にすると、email に同意済みの利用者が
    // profile だけを要求するアプリを使った瞬間に同意が黙って狭まる。
    expect([...(found?.scopes ?? [])].sort()).toEqual(["email", "openid", "profile"]);
  });

  it("取り消し済みの同意は scope を引き継がず、要求どおりに作り直す", async () => {
    const at = new Date();
    await repository().record({
      id: newGrantId(),
      userId,
      clientId: client.id,
      grantedScopes: "openid profile email",
      at,
    });
    await repository().revoke(userId, client.id, at);

    await repository().record({
      id: newGrantId(),
      userId,
      clientId: client.id,
      grantedScopes: "openid",
      at: new Date(at.getTime() + 1000),
    });

    const found = await repository().find(userId, client.id);
    expect(found?.scopes).toEqual(["openid"]);
    expect(found?.isRevoked).toBe(false);
  });

  it("取り消しは冪等（2 度目は false で、最初の時刻を上書きしない）", async () => {
    const at = new Date();
    await repository().record({
      id: newGrantId(),
      userId,
      clientId: client.id,
      grantedScopes: "openid",
      at,
    });

    expect(await repository().revoke(userId, client.id, at)).toBe(true);
    expect(await repository().revoke(userId, client.id, new Date(at.getTime() + 5000))).toBe(false);
    expect((await repository().find(userId, client.id))?.revokedAt?.getTime()).toBe(at.getTime());
  });

  it("取り消し済みの同意は covers で常に false", async () => {
    const at = new Date();
    await repository().record({
      id: newGrantId(),
      userId,
      clientId: client.id,
      grantedScopes: "openid profile email",
      at,
    });
    await repository().revoke(userId, client.id, at);

    expect((await repository().find(userId, client.id))?.covers(["openid"])).toBe(false);
  });
});

describe("DrizzleOAuthTokenRepository", () => {
  const tokens = () => new DrizzleOAuthTokenRepository(database());

  async function seedGrantAndToken(hash: string): Promise<string> {
    const grant = await new DrizzleOAuthGrantRepository(database()).record({
      id: newGrantId(),
      userId,
      clientId: client.id,
      grantedScopes: "openid",
      at: new Date(),
    });
    await tokens().issue({
      id: newGrantId(),
      tokenHash: hash,
      grantId: grant.id,
      clientId: client.id,
      userId,
      scope: "openid",
      audience: client.clientId,
      expiresAt: new Date(Date.now() + 600_000),
    });
    return grant.id;
  }

  it("失効済み・期限切れでも行は返す（可否は Domain が決める）", async () => {
    await seedGrantAndToken("hash-1");
    await tokens().revokeByTokenHash("hash-1", new Date());

    const token = await tokens().findByTokenHash("hash-1");
    // #17 の userinfo がここで 401 の理由を監査ログへ書き分けられるように、
    // 「見つからない」と「失効済み」を Repository の段階で畳まない。
    expect(token).not.toBeNull();
    expect(token?.isUsableAt(new Date())).toBe(false);
    expect(token?.isRevoked).toBe(true);
  });

  it("失効は冪等", async () => {
    await seedGrantAndToken("hash-2");
    expect(await tokens().revokeByTokenHash("hash-2", new Date())).toBe(true);
    expect(await tokens().revokeByTokenHash("hash-2", new Date())).toBe(false);
    expect(await tokens().revokeByTokenHash("no-such-hash", new Date())).toBe(false);
  });

  it("grant 単位の失効は未失効の行だけを数える", async () => {
    const grantId = await seedGrantAndToken("hash-3");
    await tokens().issue({
      id: newGrantId(),
      tokenHash: "hash-4",
      grantId,
      clientId: client.id,
      userId,
      scope: "openid",
      audience: client.clientId,
      expiresAt: new Date(Date.now() + 600_000),
    });
    await tokens().revokeByTokenHash("hash-3", new Date());

    expect(await tokens().revokeByGrant(grantId, new Date())).toBe(1);
    expect(await tokens().revokeByGrant(grantId, new Date())).toBe(0);
  });
});

describe("DrizzleAuthorizationCodeRepository の連鎖失効", () => {
  const codes = () => new DrizzleAuthorizationCodeRepository(database());

  async function seedCode(sessionId: string | null, codeHash: string): Promise<void> {
    await codes().create({
      id: newCodeId(),
      codeHash,
      clientId: client.id,
      userId,
      sessionId,
      redirectUri: "https://app.example/cb",
      scope: "openid",
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      codeChallengeMethod: "S256",
      nonce: null,
      authTime: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
  }

  it("セッション単位で未交換コードを失効させる", async () => {
    const sessionId = newSessionId();
    await seedCode(sessionId, "code-a");
    await seedCode(newSessionId(), "code-b");

    expect(await codes().revokeUnconsumedBySession(sessionId, new Date())).toBe(1);
    expect((await codes().consume("code-a", new Date())).outcome).toBe("unusable");
    expect((await codes().consume("code-b", new Date())).outcome).toBe("consumed");
  });

  it("失効は consumed_at を立てないので、後からリプレイと誤判定されない", async () => {
    const sessionId = newSessionId();
    await seedCode(sessionId, "code-c");
    await codes().revokeUnconsumedBySession(sessionId, new Date());

    const row = await database()
      .select()
      .from(oauthAuthorizationCodes)
      .all()
      .then((rows) => rows[0]);
    // `consumed_at` で失効させると、正規の RP が提示したときに
    // リプレイ（攻撃の兆候）と区別できず、無関係なトークンを巻き込む。
    expect(row?.consumedAt).toBeNull();
  });

  it("session_id を持たないコードもユーザー単位なら失効させられる", async () => {
    await seedCode(null, "code-d");
    expect(await codes().revokeUnconsumedByUser(userId, new Date())).toBe(1);
    expect((await codes().consume("code-d", new Date())).outcome).toBe("unusable");
  });

  it("消費済みのコードは連鎖失効の対象にしない", async () => {
    const sessionId = newSessionId();
    await seedCode(sessionId, "code-e");
    await codes().consume("code-e", new Date());

    expect(await codes().revokeUnconsumedBySession(sessionId, new Date())).toBe(0);
    // 交換済みのコードは replayed のまま。失効で上書きしない。
    expect((await codes().consume("code-e", new Date())).outcome).toBe("replayed");
  });
});
