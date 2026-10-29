import { env } from "cloudflare:test";
import { auditLogs, createIdentityDatabase, sessions, userEmails, users } from "@u18/db";
import { aSession, aUser, type UserFixture } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteUserEmailsSql,
  purgeStatusSql,
  purgeUserAuditSql,
  purgeUserSql,
  revokeEverythingSql,
  tombstoneEmail,
  TOMBSTONE_DISPLAY_NAME,
} from "../src/infrastructure/persistence/purge-user.sql";
import { resetDatabase } from "./helpers";

/**
 * 個人情報を落とす操作を、**運用 CLI が実際に流す SQL のまま**実物の D1 で
 * 確かめる（#265 / ランブック §11.6）。
 *
 * `scripts/purge-user.mjs` は `purge-user.sql.ts` の関数が返す文をそのまま
 * `wrangler d1 execute` へ渡す。ここで同じ関数の戻り値を D1 に流すことで、
 * **運用が通る経路そのもの**を固定する（`admin-role.test.ts` と同じ形）。
 *
 * ## ここでしか確かめられないこと
 *
 * **一意制約に当たらずに落とせるか。** `primary_email` は `notNull` かつ
 * 一意なので、空にできずトゥームストーンを入れている。**2 件続けて落としても
 * ぶつからない**ことは、実物の D1 でしか見えない。
 */
describe("個人情報を落とす（purge-user.sql）", () => {
  const db = () => createIdentityDatabase(env.IDENTITY_DB);
  const run = (sql: string) => env.IDENTITY_DB.prepare(sql).all();

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
    await db()
      .insert(userEmails)
      .values({
        id: `uem_${user.id}`,
        userId: user.id,
        email: user.email,
        verifiedAt: new Date(),
        isPrimary: true,
      })
      .run();
  }

  async function insertLiveSession(userId: string, suffix: string): Promise<void> {
    const session = aSession({ id: `ses_${suffix}`, userId });
    await db()
      .insert(sessions)
      .values({
        id: session.id,
        userId: session.userId,
        tokenHash: `hash-${suffix}`,
        // **実時刻から取る。** 固定時刻だと、実時刻がその先へ進んだ日に
        // 「期限切れ」になってテストが時計次第で落ちる（admin-role.test.ts と同じ）。
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        authMethod: session.authMethod,
        lastSeenAt: new Date(),
      })
      .run();
  }

  const victim = aUser({
    email: "taro@example.com",
    username: "taro",
    displayName: "山田 太郎",
    status: "suspended",
  });

  beforeEach(async () => {
    await resetDatabase();
    await insertUser(victim);
  });

  async function readUser(id: string) {
    const rows = await db().select().from(users).all();
    return rows.find((row) => row.id === id);
  }

  it("氏名相当とメールアドレスが残らない", async () => {
    await run(purgeUserSql(victim.id));
    await run(deleteUserEmailsSql(victim.id));

    const row = await readUser(victim.id);
    expect(row?.username).not.toBe("taro");
    expect(row?.displayName).toBe(TOMBSTONE_DISPLAY_NAME);
    expect(row?.primaryEmail).toBe(tombstoneEmail(victim.id));
    expect(row?.status).toBe("deleted");
    expect(row?.deletedAt).not.toBeNull();

    // **行のどこにも元の値が残らないこと。** 列を 1 つずつ見ると、
    // 次に列が増えたときに見落とす。
    expect(JSON.stringify(row)).not.toContain("taro@example.com");
    expect(JSON.stringify(row)).not.toContain("山田 太郎");

    const emails = await db().select().from(userEmails).all();
    expect(emails).toHaveLength(0);
  });

  it("2 件続けて落としてもぶつからない", async () => {
    // **`primary_email` は一意。** トゥームストーンに ID を含めていないと、
    // 2 人目でここが落ちる。
    const second = aUser({ email: "hanako@example.com", username: "hanako" });
    await insertUser(second);

    await run(purgeUserSql(victim.id));
    await run(purgeUserSql(second.id));

    const rows = await db().select().from(users).all();
    const emails = rows.map((row) => row.primaryEmail);
    expect(new Set(emails).size).toBe(emails.length);
  });

  it("同じアドレスで再登録できる", async () => {
    // **削除要求に応じた相手には再登録を許す。** 消したと言ったのだから、
    // 同じアドレスで作り直せないほうがおかしい。不正利用者の再登録防止は
    // `suspended`（個人情報を保持する側）が担う。
    await run(purgeUserSql(victim.id));
    await run(deleteUserEmailsSql(victim.id));

    const newcomer = aUser({ id: "usr_newcomer", email: "taro@example.com", username: "taro2" });
    await insertUser(newcomer);

    const rows = await db().select().from(users).all();
    expect(rows.some((row) => row.primaryEmail === "taro@example.com")).toBe(true);
  });

  it("既に deleted の行は二度目で変わらない", async () => {
    await run(purgeUserSql(victim.id));
    const first = await readUser(victim.id);

    const second = await run(purgeUserSql(victim.id));

    expect(second.results).toHaveLength(0);
    expect((await readUser(victim.id))?.deletedAt).toEqual(first?.deletedAt);
  });

  it("ログインの手段と発行済みの権限が残らない", async () => {
    await insertLiveSession(victim.id, "live");

    for (const statement of revokeEverythingSql(victim.id)) await run(statement);

    const rows = await db().select().from(sessions).all();
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("監査に user.purged が残る", async () => {
    await run(purgeUserAuditSql({ userId: victim.id, actor: "ops-handle", reason: "ticket-123" }));

    const rows = await db().select().from(auditLogs).all();
    const purged = rows.filter((row) => row.event === "user.purged");
    expect(purged).toHaveLength(1);
    expect(purged[0]?.userId).toBe(victim.id);
    expect(purged[0]?.actor).toBe("ops-handle");
    expect(purged[0]?.outcome).toBe("success");
  });

  it("監査には落とした中身を書かない", async () => {
    // **消した個人情報が監査ログに残っていたら、消したことにならない。**
    await run(purgeUserSql(victim.id));
    await run(purgeUserAuditSql({ userId: victim.id, actor: "ops-handle", reason: "ticket-123" }));

    const rows = await db().select().from(auditLogs).all();
    expect(JSON.stringify(rows)).not.toContain("taro@example.com");
    expect(JSON.stringify(rows)).not.toContain("山田 太郎");
  });

  it("状態の SELECT が成否をそのまま映す", async () => {
    const before = await run(purgeStatusSql(victim.id));
    expect(JSON.stringify(before.results)).toContain("taro@example.com");

    await run(purgeUserSql(victim.id));
    await run(deleteUserEmailsSql(victim.id));

    const after = await run(purgeStatusSql(victim.id));
    expect(JSON.stringify(after.results)).not.toContain("taro@example.com");
    expect(JSON.stringify(after.results)).toContain("deleted");
  });

  it("active のアカウントにも当たる", async () => {
    // **凍結を経由していなくても落とせる。** 削除要求に応えるのに先に
    // 凍結する手順を強いる理由が無い。**どちらとも読める状態にしない**
    // ため、ここで固定する（運用としては凍結を先にするのがよい、という
    // のは別の話でランブック §11.6 に書いてある）。
    const live = aUser({ id: "usr_live", email: "live@example.com", username: "live" });
    await insertUser(live);

    const result = await run(purgeUserSql(live.id));

    expect(result.results).toHaveLength(1);
    expect((await readUser(live.id))?.status).toBe("deleted");
  });

  it("ID に ' が入っていても文が壊れない", async () => {
    // SQL 注入。値は運用者の手元からしか来ないが、サポート窓口のチケットや
    // 他システムの出力から貼られるもので、**文が壊れるのではなく意味が変わる。**
    const sql = purgeUserSql("usr_x' or '1'='1");
    expect(sql).toContain("usr_x'' or ''1''=''1");

    // 流しても他の行に当たらない。
    await run(sql);
    expect((await readUser(victim.id))?.status).toBe("suspended");
  });
});
