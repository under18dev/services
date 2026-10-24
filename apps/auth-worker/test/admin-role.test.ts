import { env } from "cloudflare:test";
import { createIdentityDatabase, passkeys, sessions, users } from "@u18/db";
import { aPasskey } from "./fakes.passkey";
import { aSession, aUser, type UserFixture } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  adminRoleAuditSql,
  adminRoleStatusSql,
  grantAdminSql,
  revokeAdminSql,
  revokeNonPasskeySessionsSql,
  sqlLiteral,
} from "../src/infrastructure/persistence/admin-role.sql";
import { DrizzleUserRepository } from "../src/infrastructure/persistence/drizzle-user.repository";
import { resetDatabase } from "./helpers";

/**
 * 管理権限の付与・剥奪を、**運用 CLI が実際に流す SQL のまま**実物の D1 で確かめる
 * （仕様書 §14.1 決定 8 / #83）。
 *
 * `scripts/admin-role.mjs` は `admin-role.sql.ts` の関数が返す文をそのまま
 * `wrangler d1 execute` へ渡す。ここで同じ関数の戻り値を D1 に流すことで、
 * 「Passkey が無ければ権限は立たない」をアプリ側の重複実装ではなく
 * **運用が通る経路そのもの**で固定する。インメモリの代替では、条件を
 * UPDATE の WHERE に畳んであること（＝確認と書き込みの間に隙間が無いこと）を
 * 検証できない。
 */
describe("管理権限の付与（admin-role.sql）", () => {
  const db = () => createIdentityDatabase(env.IDENTITY_DB);

  async function insertUser(user: UserFixture): Promise<void> {
    await db()
      .insert(users)
      .values({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        primaryEmail: user.email,
        emailVerified: user.emailVerified,
        status: user.status,
        isAdmin: user.isAdmin,
        deletedAt: user.deletedAt,
      })
      .run();
  }

  async function insertPasskey(userId: string, suffix: string): Promise<void> {
    const passkey = aPasskey({
      id: `pky_${suffix}`,
      userId,
      credentialId: `cred-${suffix}`,
    });
    await db()
      .insert(passkeys)
      .values({
        id: passkey.id,
        userId: passkey.userId,
        credentialId: passkey.credentialId,
        publicKey: passkey.publicKey,
        counter: passkey.counter,
        backedUp: passkey.backedUp,
      })
      .run();
  }

  /**
   * 生きたセッションを 1 本置く。
   *
   * **有効期限は固定時刻ではなく実時刻から取る。** 失効の SQL は SQLite の
   * `unixepoch()`（＝実時刻）で期限を見るので、`aSession()` の既定値
   * （FIXED_NOW から 12 時間）を使うと、実時刻がその先へ進んだ日には
   * 「期限切れだから対象外」になってテストが時計次第で落ちる。
   */
  async function insertSession(
    userId: string,
    id: string,
    authMethod: "passkey" | "email_otp",
  ): Promise<void> {
    const session = aSession({ id, userId, authMethod });
    await db()
      .insert(sessions)
      .values({
        id: session.id,
        userId: session.userId,
        tokenHash: session.tokenHash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        authMethod: session.authMethod,
        lastSeenAt: new Date(),
      })
      .run();
  }

  /** 文をそのまま流す。CLI の `wrangler d1 execute --command` と同じ扱い。 */
  async function run(sql: string): Promise<D1Result> {
    return env.IDENTITY_DB.prepare(sql).all();
  }

  async function isAdmin(userId: string): Promise<boolean> {
    const user = await new DrizzleUserRepository(db()).findById(userId);
    return user?.isAdmin ?? false;
  }

  beforeEach(async () => {
    await resetDatabase();
  });

  it("Passkey が 1 本も無いアカウントには付与できない", async () => {
    // 付与できてしまうと、生まれるのは「権限はあるがログインできない管理者」か
    // 「OTP で入れる管理者」のどちらか。後者は決定 8 が排除した設計そのもの。
    const user = aUser();
    await insertUser(user);

    const result = await run(grantAdminSql(user.id));

    expect(result.results).toEqual([]);
    expect(await isAdmin(user.id)).toBe(false);
  });

  it("Passkey が 1 本でもあれば付与できる", async () => {
    const user = aUser();
    await insertUser(user);
    await insertPasskey(user.id, "one");

    const result = await run(grantAdminSql(user.id));

    expect(result.results).toHaveLength(1);
    expect(await isAdmin(user.id)).toBe(true);
  });

  it("他人の Passkey では付与できない", async () => {
    // `exists` の相関条件が抜けると、誰か 1 人でも Passkey を持っていれば
    // 全員に付与できてしまう。条件が user_id で結ばれていることを固定する。
    const target = aUser();
    const other = aUser();
    await insertUser(target);
    await insertUser(other);
    await insertPasskey(other.id, "other");

    await run(grantAdminSql(target.id));

    expect(await isAdmin(target.id)).toBe(false);
  });

  it("凍結・論理削除されたアカウントには付与できない", async () => {
    const suspended = aUser({ status: "suspended" });
    const deleted = aUser({ status: "active", deletedAt: new Date("2026-10-01T00:00:00.000Z") });
    await insertUser(suspended);
    await insertUser(deleted);
    await insertPasskey(suspended.id, "suspended");
    await insertPasskey(deleted.id, "deleted");

    await run(grantAdminSql(suspended.id));
    await run(grantAdminSql(deleted.id));

    expect(await isAdmin(suspended.id)).toBe(false);
    expect(await isAdmin(deleted.id)).toBe(false);
  });

  it("すでに管理者なら何も起きない（監査ログに二重の付与を残さないため）", async () => {
    const user = aUser({ isAdmin: true });
    await insertUser(user);
    await insertPasskey(user.id, "one");

    const result = await run(grantAdminSql(user.id));

    expect(result.results).toEqual([]);
  });

  it("付与と同時に OTP のセッションを失効させ、Passkey のセッションは残す", async () => {
    // 付与より前に張られた OTP セッションは、権限が立った瞬間に
    // 「OTP で入った管理者のセッション」になる。IssueSessionUseCase が
    // 止められるのは新規発行だけなので、既存の分はここで落とす。
    const user = aUser();
    await insertUser(user);
    await insertPasskey(user.id, "one");
    await insertSession(user.id, "ses_otp", "email_otp");
    await insertSession(user.id, "ses_passkey", "passkey");

    await run(grantAdminSql(user.id));
    const revoked = await run(revokeNonPasskeySessionsSql(user.id));

    expect(revoked.results).toHaveLength(1);
    const rows = await env.IDENTITY_DB.prepare(
      "select id, revoked_at from sessions order by id",
    ).all<{ id: string; revoked_at: number | null }>();
    expect(rows.results.find((r) => r.id === "ses_otp")?.revoked_at).not.toBeNull();
    expect(rows.results.find((r) => r.id === "ses_passkey")?.revoked_at).toBeNull();
  });

  it("剥奪は Passkey の本数に関係なく通る", async () => {
    // 権限を減らす操作に前提条件を置くと、「今すぐ落としたいのに落とせない」
    // 状況が作れてしまう。
    const user = aUser({ isAdmin: true });
    await insertUser(user);

    const result = await run(revokeAdminSql(user.id));

    expect(result.results).toHaveLength(1);
    expect(await isAdmin(user.id)).toBe(false);
  });

  it("管理者でなければ剥奪は 0 行（CLI はこれを見て失敗を伝える）", async () => {
    const user = aUser();
    await insertUser(user);

    const result = await run(revokeAdminSql(user.id));

    expect(result.results).toEqual([]);
  });

  it("付与・剥奪を監査ログに残す", async () => {
    const user = aUser();
    await insertUser(user);

    await run(
      adminRoleAuditSql({
        event: "ops.admin.granted",
        userId: user.id,
        actor: "ops-handle",
        reason: "manual_grant",
      }),
    );

    const rows = await env.IDENTITY_DB.prepare(
      "select event, user_id, actor, outcome, reason from audit_logs",
    ).all<{ event: string; user_id: string; actor: string; outcome: string; reason: string }>();
    expect(rows.results).toEqual([
      {
        event: "ops.admin.granted",
        user_id: user.id,
        actor: "ops-handle",
        outcome: "success",
        reason: "manual_grant",
      },
    ]);
  });

  it("状態の表示は Passkey 本数と生きている OTP セッション数を返す", async () => {
    const user = aUser();
    await insertUser(user);
    await insertPasskey(user.id, "one");
    await insertSession(user.id, "ses_otp", "email_otp");

    const result = await run(adminRoleStatusSql(user.id));

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ id: user.id, passkeys: 1, otp_sessions: 1 });
  });

  it("ID に `'` を含めても文の意味が変わらない", async () => {
    // ユーザー ID はチケットや他システムの出力から貼られる。エスケープが
    // 抜けると、文が壊れるのではなく**意味が変わる**のが SQL 注入である。
    const victim = aUser();
    await insertUser(victim);
    await insertPasskey(victim.id, "one");

    // 「全員を管理者にする」を狙った入力。1 行も一致しないのが正しい。
    const injection = "' or '1'='1";
    const result = await run(grantAdminSql(injection));

    expect(result.results).toEqual([]);
    expect(await isAdmin(victim.id)).toBe(false);
    expect(sqlLiteral(injection)).toBe("''' or ''1''=''1'");
  });
});
