import { env } from "cloudflare:test";
import { aSession, aUser } from "@u18/testing";
import { createIdentityDatabase, sessions, users } from "@u18/db";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleSessionRepository } from "../src/infrastructure/persistence/drizzle-session.repository";
import { applyMigrations, resetDatabase } from "./helpers";

describe("DrizzleSessionRepository", () => {
  let repo: DrizzleSessionRepository;
  let db: ReturnType<typeof createIdentityDatabase>;
  const user = aUser();

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await resetDatabase();
    db = createIdentityDatabase(env.IDENTITY_DB);
    repo = new DrizzleSessionRepository(db);
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
  });

  it("作成したセッションをトークンハッシュで引ける", async () => {
    const fixture = aSession({ userId: user.id });
    await repo.create({
      id: fixture.id,
      userId: fixture.userId,
      tokenHash: fixture.tokenHash,
      expiresAt: fixture.expiresAt,
      authMethod: fixture.authMethod,
      userAgent: fixture.userAgent,
      ipHash: fixture.ipHash,
    });

    const found = await repo.findByTokenHash(fixture.tokenHash);
    expect(found?.id).toBe(fixture.id);
    expect(found?.userId).toBe(user.id);
    expect(found?.isUsableAt(new Date("2026-10-24T01:00:00.000Z"))).toBe(true);
  });

  it("存在しないトークンハッシュでは null を返す", async () => {
    expect(await repo.findByTokenHash("nope")).toBeNull();
  });

  it("失効させると isUsableAt が false になる", async () => {
    const fixture = aSession({ userId: user.id });
    await repo.create({ ...fixture, authMethod: fixture.authMethod });

    const revoked = await repo.revoke(fixture.id, new Date());
    expect(revoked).toBe(true);

    const found = await repo.findById(fixture.id);
    expect(found?.isRevoked).toBe(true);
    expect(found?.isUsableAt(new Date())).toBe(false);
  });

  it("同時に 2 回失効させても成功するのは 1 回だけ", async () => {
    const fixture = aSession({ userId: user.id });
    await repo.create({ ...fixture, authMethod: fixture.authMethod });

    const [first, second] = await Promise.all([
      repo.revoke(fixture.id, new Date()),
      repo.revoke(fixture.id, new Date()),
    ]);

    // 条件付き UPDATE (`revoked_at IS NULL`) により、片方だけが行を更新する。
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("期限切れのセッションは使えない", async () => {
    const fixture = aSession({
      userId: user.id,
      expiresAt: new Date("2026-10-23T00:00:00.000Z"),
    });
    await repo.create({ ...fixture, authMethod: fixture.authMethod });

    const found = await repo.findByTokenHash(fixture.tokenHash);
    expect(found?.isUsableAt(new Date("2026-10-24T00:00:00.000Z"))).toBe(false);
  });

  it("ユーザーの全セッションを一括失効できる", async () => {
    const a = aSession({ userId: user.id });
    const b = aSession({ userId: user.id });
    await repo.create({ ...a, authMethod: a.authMethod });
    await repo.create({ ...b, authMethod: b.authMethod });

    expect(await repo.revokeAllForUser(user.id, new Date())).toBe(2);
    // 2 回目は失効対象が残っていないので 0。
    expect(await repo.revokeAllForUser(user.id, new Date())).toBe(0);
  });

  it("ユーザーを削除するとセッションも消える", async () => {
    const fixture = aSession({ userId: user.id });
    await repo.create({ ...fixture, authMethod: fixture.authMethod });

    await env.IDENTITY_DB.prepare("pragma foreign_keys = on").run();
    await db.delete(users).where(eq(users.id, user.id)).run();

    const remaining = await db.select().from(sessions).all();
    expect(remaining).toHaveLength(0);
  });
});
