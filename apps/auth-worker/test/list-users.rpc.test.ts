import { users } from "@u18/db";
import { createExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { IdentityAdminRPC } from "../src/presentation/rpc/identity-admin.entrypoint";
import { resetDatabase } from "./helpers";
import { appEnv, db, seedLoggedInUser, type SeededUser } from "./helpers.oauth";

/**
 * 利用者の一覧（#375 / #382）。**他人を指す最初の RPC である。**
 *
 * ## このファイルが守っているもの
 *
 * 1. **管理者でなければ 1 行も返らない。** 一覧は「u18 に誰が居るか」
 *    そのものなので、壁が抜けると名簿が丸ごと出る
 * 2. **決定 8 がここにも効く**（#337）。旗が立っていても OTP の
 *    セッションでは通らない
 * 3. **カーソルが終端で止まる。** 止まらないと同じ人が出続ける
 */

const rpc = new IdentityAdminRPC(createExecutionContext(), appEnv());

/** 管理者。**`passkey` のセッションでないと決定 8 に弾かれる。** */
async function seedAdmin(): Promise<SeededUser> {
  return seedLoggedInUser({ isAdmin: true, authMethod: "passkey" });
}

/**
 * 一覧に出る利用者を 1 人作る。
 *
 * **`seedLoggedInUser` を使わない。** あれはセッションも作るので、
 * 「ログインしたことがない利用者」が作れない。一覧は `users` を見るので
 * 行だけあればよい。
 */
async function seedPlainUser(fields: {
  id: string;
  username: string;
  email: string;
  createdAt: Date;
  status?: "active" | "suspended" | "deleted";
}): Promise<void> {
  await db()
    .insert(users)
    .values({
      id: fields.id,
      username: fields.username,
      displayName: `名前 ${fields.username}`,
      primaryEmail: fields.email,
      emailVerified: true,
      status: fields.status ?? "active",
      createdAt: fields.createdAt,
    })
    .run();
}

beforeEach(resetDatabase);

describe("listUsers の壁", () => {
  it("一般利用者には not_found（forbidden ではない）", async () => {
    const user = await seedLoggedInUser();

    const result = await rpc.listUsers({
      sessionToken: user.sessionToken,
      caller: "dashboard-worker",
    });

    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("旗が立っていても、OTP のセッションでは通らない（決定 8 / RR-5）", async () => {
    // **`requireAdminSession` は `GetSessionUseCase` の `isAdmin` を見る。**
    // あれは `User.actsAsAdminWith(authMethod)` なので、ここに判定を
    // 書き足さなくても効いている —— **効いていることを固定する。**
    const user = await seedLoggedInUser({ isAdmin: true, authMethod: "email_otp" });

    const result = await rpc.listUsers({
      sessionToken: user.sessionToken,
      caller: "dashboard-worker",
    });

    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("壊れたセッションでは通らない", async () => {
    const result = await rpc.listUsers({
      sessionToken: "session-token-does-not-exist",
      caller: "dashboard-worker",
    });

    expect(result.ok).toBe(false);
  });
});

describe("listUsers が返すもの", () => {
  it("管理者には一覧が返り、メールアドレスも載る", async () => {
    const admin = await seedAdmin();
    await seedPlainUser({
      id: "usr_a",
      username: "alice",
      email: "alice@example.com",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });

    const result = await rpc.listUsers({
      sessionToken: admin.sessionToken,
      caller: "dashboard-worker",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const alice = result.value.users.find((u) => u.id === "usr_a");
    expect(alice?.primaryEmail).toBe("alice@example.com");
    expect(alice?.username).toBe("alice");
  });

  it("パスキーもセッショントークンも載らない", async () => {
    const admin = await seedAdmin();

    const result = await rpc.listUsers({
      sessionToken: admin.sessionToken,
      caller: "dashboard-worker",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // **型に無いので詰めようがない**（RR-13 と同じ形）。
    // 値の側からも確かめておく —— 型を広げた瞬間にここが落ちる。
    const keys = Object.keys(result.value.users[0] ?? {}).sort();
    expect(keys).toEqual([
      "createdAt",
      "displayName",
      "emailVerified",
      "hasAdminFlag",
      "id",
      "primaryEmail",
      "status",
      "username",
    ]);
  });

  it("新しい順に返る", async () => {
    const admin = await seedAdmin();
    await seedPlainUser({
      id: "usr_old",
      username: "old",
      email: "old@example.com",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await seedPlainUser({
      id: "usr_new",
      username: "new",
      email: "new@example.com",
      createdAt: new Date("2026-10-29T00:00:00.000Z"),
    });

    const result = await rpc.listUsers({
      sessionToken: admin.sessionToken,
      caller: "dashboard-worker",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.users.map((u) => u.id);
    expect(ids.indexOf("usr_new")).toBeLessThan(ids.indexOf("usr_old"));
  });

  it("メールアドレスで完全一致する（大文字小文字は無視）", async () => {
    const admin = await seedAdmin();
    await seedPlainUser({
      id: "usr_a",
      username: "alice",
      email: "alice@example.com",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });

    const result = await rpc.listUsers({
      sessionToken: admin.sessionToken,
      caller: "dashboard-worker",
      query: "ALICE@EXAMPLE.COM",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.users.map((u) => u.id)).toEqual(["usr_a"]);
  });

  it("部分一致では拾わない", async () => {
    const admin = await seedAdmin();
    await seedPlainUser({
      id: "usr_a",
      username: "alice",
      email: "alice@example.com",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });

    const result = await rpc.listUsers({
      sessionToken: admin.sessionToken,
      caller: "dashboard-worker",
      query: "alice@",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // **部分一致を持たない。** 索引から外れるうえ、思っていない行を拾う。
    expect(result.value.users).toEqual([]);
  });

  it("username でも引ける", async () => {
    const admin = await seedAdmin();
    await seedPlainUser({
      id: "usr_a",
      username: "alice",
      email: "alice@example.com",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });

    const result = await rpc.listUsers({
      sessionToken: admin.sessionToken,
      caller: "dashboard-worker",
      query: "alice",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.users.map((u) => u.id)).toEqual(["usr_a"]);
  });

  it("退会・凍結した人も出る", async () => {
    const admin = await seedAdmin();
    await seedPlainUser({
      id: "usr_s",
      username: "suspended",
      email: "s@example.com",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      status: "suspended",
    });

    const result = await rpc.listUsers({
      sessionToken: admin.sessionToken,
      caller: "dashboard-worker",
      query: "s@example.com",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // **除くと、問い合わせてきた本人を管理者が見つけられない。**
    expect(result.value.users[0]?.status).toBe("suspended");
  });
});

describe("listUsers のカーソル", () => {
  it("続きがあるときだけ返り、終端では null になる", async () => {
    const admin = await seedAdmin();
    for (let i = 0; i < 3; i += 1) {
      await seedPlainUser({
        id: `usr_${i}`,
        username: `u${i}`,
        email: `u${i}@example.com`,
        createdAt: new Date(Date.UTC(2026, 9, 1 + i)),
      });
    }

    const first = await rpc.listUsers({
      sessionToken: admin.sessionToken,
      caller: "dashboard-worker",
      limit: 2,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.users).toHaveLength(2);
    expect(first.value.nextCursor).not.toBeNull();

    const seen = new Set(first.value.users.map((u) => u.id));
    let cursor = first.value.nextCursor;
    let guard = 0;
    while (cursor !== null && guard < 10) {
      const page = await rpc.listUsers({
        sessionToken: admin.sessionToken,
        caller: "dashboard-worker",
        limit: 2,
        cursor,
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      // **空のページを返さない。** `nextCursor` を「ちょうど limit 件
      // あったか」で決めると、**件数が limit の倍数のときに空のページが
      // 1 回増える** —— 利用者には「続きを読む」を押したのに何も出ない
      // 画面として見える。余分に 1 件読んで実在を確かめているのはそのため。
      expect(page.value.users.length).toBeGreaterThan(0);
      for (const u of page.value.users) {
        // **同じ人が 2 度出ない。** 出るならカーソルが進んでいない。
        expect(seen.has(u.id)).toBe(false);
        seen.add(u.id);
      }
      cursor = page.value.nextCursor;
      guard += 1;
    }

    // **終端で止まる。** 止まらないと送り続けても終わらない。
    expect(cursor).toBeNull();
    // 管理者自身も含めて 4 人。
    expect(seen.size).toBe(4);
  });

  it("壊れたカーソルは invalid_input（黙って先頭へ戻さない）", async () => {
    const admin = await seedAdmin();

    const result = await rpc.listUsers({
      sessionToken: admin.sessionToken,
      caller: "dashboard-worker",
      cursor: "not-a-cursor",
    });

    // 先頭へ戻すと、画面を送り続けても同じ人が出続ける。
    expect(!result.ok && result.error.code).toBe("invalid_input");
  });

  it("管理者でなければ、壊れたカーソルでも not_found が先に来る", async () => {
    // **壁が先。** 入力の検査が先だと、`invalid_input` と `not_found` の
    // 出し分けから「管理者かどうか」が読める。
    const user = await seedLoggedInUser();

    const result = await rpc.listUsers({
      sessionToken: user.sessionToken,
      caller: "dashboard-worker",
      cursor: "not-a-cursor",
    });

    expect(!result.ok && result.error.code).toBe("not_found");
  });
});

describe("listUsers は audit_logs に書かない", () => {
  it("成功しても拒否しても行が増えない", async () => {
    const admin = await seedAdmin();
    const user = await seedLoggedInUser();
    const { auditLogs } = await import("@u18/db");
    const before = (await db().select().from(auditLogs).all()).length;

    await rpc.listUsers({ sessionToken: admin.sessionToken, caller: "dashboard-worker" });
    await rpc.listUsers({ sessionToken: user.sessionToken, caller: "dashboard-worker" });

    // **拒否のたびに書くと、有効なセッションを持つ相手が呼ぶだけで
    // `audit_logs` を伸ばせる**（RPC 経路にレート制限は無い）。
    expect((await db().select().from(auditLogs).all()).length).toBe(before);
    void eq;
  });
});
