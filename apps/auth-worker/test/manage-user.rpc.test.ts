import { auditLogs, sessions, users } from "@u18/db";
import { createExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { IdentityAdminRPC } from "../src/presentation/rpc/identity-admin.entrypoint";
import { resetDatabase } from "./helpers";
import { appEnv, db, seedLoggedInUser, type SeededUser } from "./helpers.oauth";

/**
 * 利用者の停止・解除・セッションの失効（#375 / #382）。
 *
 * ## ここでしか確かめられないこと
 *
 * 1. **理由が `audit_logs` に残ること。** `status` は `suspended` の
 *    1 値しか持たず、本人の退会（#318）とも同じ値になる。**残っていないと
 *    「戻してよいのか」を判断する材料が消える**
 * 2. **自分を止められないこと。** 止めた瞬間に自分のセッションが死に、
 *    解除する人が居なくなる
 * 3. **`deleted` を戻せないこと。** 個人情報が落ちているのに `active` に
 *    見えるアカウントを作らない
 */

const rpc = new IdentityAdminRPC(createExecutionContext(), appEnv());
const CALLER = "dashboard-worker" as const;

/** 管理者。**`passkey` のセッションでないと決定 8 に弾かれる。** */
function seedAdmin(): Promise<SeededUser> {
  return seedLoggedInUser({ isAdmin: true, authMethod: "passkey" });
}

async function statusOf(userId: string): Promise<string | undefined> {
  const rows = await db().select().from(users).where(eq(users.id, userId)).all();
  return rows[0]?.status;
}

async function auditFor(event: string) {
  const rows = await db().select().from(auditLogs).where(eq(auditLogs.event, event)).all();
  return rows;
}

beforeEach(resetDatabase);

describe("suspendUser", () => {
  it("一般利用者には not_found（壁が先）", async () => {
    const actor = await seedLoggedInUser();
    const target = await seedLoggedInUser();

    const result = await rpc.suspendUser({
      sessionToken: actor.sessionToken,
      caller: CALLER,
      userId: target.userId,
      reason: "abuse",
    });

    expect(!result.ok && result.error.code).toBe("not_found");
    // **壁の手前で 1 行も動いていないこと。**
    expect(await statusOf(target.userId)).toBe("active");
  });

  it("古いセッションの管理者には再認証を要求する", async () => {
    const admin = await seedLoggedInUser({
      isAdmin: true,
      authMethod: "passkey",
      authTime: new Date(Date.now() - 60 * 60 * 1000),
    });
    const target = await seedLoggedInUser();

    const result = await rpc.suspendUser({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      userId: target.userId,
      reason: "abuse",
    });

    expect(!result.ok && result.error.code).toBe("reauthentication_required");
    expect(await statusOf(target.userId)).toBe("active");
  });

  it("管理者は止められ、セッションも切れる", async () => {
    const admin = await seedAdmin();
    const target = await seedLoggedInUser();

    const result = await rpc.suspendUser({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      userId: target.userId,
      reason: "abuse",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revokedSessions).toBeGreaterThan(0);
    expect(await statusOf(target.userId)).toBe("suspended");

    const live = await db().select().from(sessions).where(eq(sessions.userId, target.userId)).all();
    expect(live.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("理由が audit_logs に残る（status は 1 値しか持たない）", async () => {
    const admin = await seedAdmin();
    const target = await seedLoggedInUser();

    await rpc.suspendUser({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      userId: target.userId,
      reason: "compromise",
    });

    const rows = await auditFor("ops.user.suspended");
    expect(rows).toHaveLength(1);
    // **`metadata` は既にオブジェクトで返る**（drizzle の json モード）。
    // 文字列として読もうとすると `[object Object]` を JSON.parse する。
    const metadata = (rows[0]?.metadata ?? {}) as Record<string, unknown>;
    // **ここが唯一の保存先である。** 消えると、戻してよいか判断できない。
    expect(metadata["reason"]).toBe("compromise");
    // **誰がやったかも本文に入れる。** `actor` は Worker 名なので、
    // 管理者が複数になったときに人を特定できない。
    expect(metadata["actorUserId"]).toBe(admin.userId);
    expect(rows[0]?.userId).toBe(target.userId);
  });

  it("自分は止められない", async () => {
    const admin = await seedAdmin();

    const result = await rpc.suspendUser({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      userId: admin.userId,
      reason: "abuse",
    });

    // 止めると解除する人が居なくなる。
    expect(!result.ok && result.error.code).toBe("conflict");
    expect(await statusOf(admin.userId)).toBe("active");
  });

  it("2 度目は conflict（既に止まっている）", async () => {
    const admin = await seedAdmin();
    const target = await seedLoggedInUser();

    await rpc.suspendUser({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      userId: target.userId,
      reason: "abuse",
    });
    const second = await rpc.suspendUser({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      userId: target.userId,
      reason: "abuse",
    });

    expect(!second.ok && second.error.code).toBe("conflict");
    // **記録を 2 本にしない。** 通っていない操作は残さない。
    expect(await auditFor("ops.user.suspended")).toHaveLength(1);
  });

  it("存在しない利用者も conflict（居ないことを教えない）", async () => {
    const admin = await seedAdmin();

    const result = await rpc.suspendUser({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      userId: "usr_does_not_exist",
      reason: "abuse",
    });

    // `not_found` にすると、ID の総当たりで在籍を当てられる。
    expect(!result.ok && result.error.code).toBe("conflict");
  });
});

describe("reinstateUser", () => {
  it("止まっている人を戻せる", async () => {
    const admin = await seedAdmin();
    const target = await seedLoggedInUser({ status: "suspended" });

    const result = await rpc.reinstateUser({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      userId: target.userId,
    });

    expect(result.ok).toBe(true);
    expect(await statusOf(target.userId)).toBe("active");
    expect(await auditFor("ops.user.reinstated")).toHaveLength(1);
  });

  it("deleted は戻せない", async () => {
    const admin = await seedAdmin();
    const target = await seedLoggedInUser();
    await db().update(users).set({ status: "deleted" }).where(eq(users.id, target.userId)).run();

    const result = await rpc.reinstateUser({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      userId: target.userId,
    });

    // **個人情報が落ちているのに `active` に見えるアカウントを作らない。**
    expect(!result.ok && result.error.code).toBe("conflict");
    expect(await statusOf(target.userId)).toBe("deleted");
  });

  it("active な人を戻そうとしても何も起きない", async () => {
    const admin = await seedAdmin();
    const target = await seedLoggedInUser();

    const result = await rpc.reinstateUser({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      userId: target.userId,
    });

    expect(!result.ok && result.error.code).toBe("conflict");
    expect(await auditFor("ops.user.reinstated")).toHaveLength(0);
  });
});

describe("revokeUserSessions", () => {
  it("止めずに切れる", async () => {
    const admin = await seedAdmin();
    const target = await seedLoggedInUser();

    const result = await rpc.revokeUserSessions({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      userId: target.userId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revokedSessions).toBeGreaterThan(0);
    // **止めていない。** 本人はログインし直せる。
    expect(await statusOf(target.userId)).toBe("active");
    expect(await auditFor("ops.user.sessions_revoked")).toHaveLength(1);
  });

  it("自分に対しては許す（全端末からログアウト）", async () => {
    const admin = await seedAdmin();

    const result = await rpc.revokeUserSessions({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      userId: admin.userId,
    });

    // 止めるのと違って、自分に対しても意味がある操作である。
    expect(result.ok).toBe(true);
  });

  it("一般利用者には not_found", async () => {
    const actor = await seedLoggedInUser();
    const target = await seedLoggedInUser();

    const result = await rpc.revokeUserSessions({
      sessionToken: actor.sessionToken,
      caller: CALLER,
      userId: target.userId,
    });

    expect(!result.ok && result.error.code).toBe("not_found");
  });
});
