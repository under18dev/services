import { auditLogs, oauthClients, users } from "@u18/db";
import { createExecutionContext, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { IdentityAdminDelegatedRPC } from "../src/presentation/rpc/identity-admin-delegated.entrypoint";
import { resetDatabase } from "./helpers";
import { appEnv, db, seedClient, seedLoggedInUser, type SeededUser } from "./helpers.oauth";

/**
 * `IdentityAdminDelegatedRPC`（#390 決定 16 ③）。
 *
 * ## ここで確かめること
 *
 * **これは `IdentityAdminRPC` とは別の信頼モデルである。** `sessionToken`
 * を一切受け取らない —— admin-worker は Service Binding の到達性だけで
 * 呼べる（`NfcAdminDelegatedRPC` と同じ形、94 の実装と同じレビュー基準）。
 *
 *  1. **`actorUserId` を検証せず、そのまま監査へ記録する**こと。ただし
 *     **実在しない `actorUserId` は `invalid_input` で弾く**
 *     （`requireExistingActor`）
 *  2. **管理者かどうかを一切確かめない**こと —— 一般利用者の `userId` を
 *     `actorUserId` に渡しても通る（それが設計である）
 *  3. **自分を止められない**（`suspendUser`）、**一次パーティを失効
 *     させられない**（`disableOAuthClient`）など、`ManageUserUseCase` /
 *     `DisableOAuthClientUseCase` が持っていた「認可以外」の制約は
 *     そのまま残っていること
 *  4. **`IdentityAdminRpcContract`（dashboard 向け）には影響しない**こと
 */

const CALLER = undefined; // delegated 契約に `caller` は無い。

let rpc: IdentityAdminDelegatedRPC;

beforeEach(async () => {
  await resetDatabase();
  rpc = new IdentityAdminDelegatedRPC(createExecutionContext(), appEnv());
});

async function seedPlainUser(fields: {
  id: string;
  username: string;
  email: string;
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
    })
    .run();
}

describe("actorUserId は検証しない。実在だけ確かめる", () => {
  it("一般利用者の userId を actorUserId に渡しても通る（管理者判定が無い）", async () => {
    // **これが設計である。** 認可の境界は Service Binding そのもので、
    // admin-worker が呼ぶ前に承認リストを確かめている前提。
    const user: SeededUser = await seedLoggedInUser();

    const result = await rpc.listUsers({ actorUserId: user.userId });

    expect(result.ok).toBe(true);
  });

  it("書く操作では、実在しない actorUserId を invalid_input で弾く（not_found ではない）", async () => {
    // `not_found` は `requireAdminSession` が「管理機能の存在を隠す」ために
    // 使う値。ここで同じ値を返すと 2 つの違う意味が混ざる。
    //
    // **読み取り（`listUsers` など）はこの確認をしない。** `actorUserId` を
    // 監査へ書かないので、確かめる理由が無い —— 下の別ブロックで固定する。
    const target: SeededUser = await seedLoggedInUser();

    const result = await rpc.suspendUser({
      actorUserId: "usr_does_not_exist",
      userId: target.userId,
      reason: "abuse",
    });

    expect(!result.ok && result.error.code).toBe("invalid_input");
  });

  it("読み取り（listUsers / listOAuthClients / countOAuthClients / countUsers / listAuditLogs）は実在確認すら求めない", async () => {
    // 読み取りは `actorUserId` を監査へ書かないので、確かめる理由も無い
    // （書く操作とは非対称。`DelegatedListUsersUseCase` の JSDoc 参照）。
    const users1 = await rpc.listUsers({ actorUserId: "usr_does_not_exist" });
    const clients1 = await rpc.listOAuthClients({ actorUserId: "usr_does_not_exist" });
    const count1 = await rpc.countOAuthClients({ actorUserId: "usr_does_not_exist" });
    const userCount1 = await rpc.countUsers({ actorUserId: "usr_does_not_exist" });
    const logs1 = await rpc.listAuditLogs({ actorUserId: "usr_does_not_exist" });

    expect(users1.ok).toBe(true);
    expect(clients1.ok).toBe(true);
    expect(count1.ok).toBe(true);
    expect(userCount1.ok).toBe(true);
    expect(logs1.ok).toBe(true);
  });
});

describe("countOAuthClients", () => {
  it("登録した分だけ増える", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const before = await rpc.countOAuthClients({ actorUserId: admin.userId });
    expect(before.ok, "countOAuthClients が失敗した").toBe(true);
    const beforeCount = before.ok ? before.value : 0;

    await rpc.createOAuthClient({
      actorUserId: admin.userId,
      name: "App A",
      clientType: "public",
      redirectUris: ["https://a.example/cb"],
    });
    await rpc.createOAuthClient({
      actorUserId: admin.userId,
      name: "App B",
      clientType: "public",
      redirectUris: ["https://b.example/cb"],
    });

    const after = await rpc.countOAuthClients({ actorUserId: admin.userId });
    // **既存の件数（u18-dashboard のような既定のクライアント）には
    // 依存させない。** 「作った 2 件ぶん増えた」ことだけを見る。
    expect(after.ok && after.value).toBe(beforeCount + 2);
  });

  it("失効済みも数える（listAll と同じ事実をそのまま返す判断）", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const before = await rpc.countOAuthClients({ actorUserId: admin.userId });
    expect(before.ok).toBe(true);
    const beforeCount = before.ok ? before.value : 0;

    const created = await rpc.createOAuthClient({
      actorUserId: admin.userId,
      name: "x",
      clientType: "public",
      redirectUris: ["https://app.example/cb"],
    });
    if (!created.ok) throw new Error("登録に失敗した");
    await rpc.disableOAuthClient({
      actorUserId: admin.userId,
      clientId: created.value.client.clientId,
    });

    const after = await rpc.countOAuthClients({ actorUserId: admin.userId });
    expect(after.ok && after.value).toBe(beforeCount + 1);
  });
});

describe("countUsers（#512）", () => {
  it("状態ごとに分けて数える。既存の件数には依存しない", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const before = await rpc.countUsers({ actorUserId: admin.userId });
    expect(before.ok, "countUsers が失敗した").toBe(true);
    if (!before.ok) return;

    await seedPlainUser({ id: "usr_active_1", username: "active1", email: "a1@example.com" });
    await seedPlainUser({
      id: "usr_suspended_1",
      username: "suspended1",
      email: "s1@example.com",
      status: "suspended",
    });
    await seedPlainUser({
      id: "usr_deleted_1",
      username: "deleted1",
      email: "d1@example.com",
      status: "deleted",
    });

    const after = await rpc.countUsers({ actorUserId: admin.userId });
    expect(after.ok).toBe(true);
    if (!after.ok) return;

    // admin 自身（seedLoggedInUser）も active の1人として数えられている
    // ので、「増えた分」だけを見る——既存件数には依存しない。
    expect(after.value.active).toBe(before.value.active + 1);
    expect(after.value.suspended).toBe(before.value.suspended + 1);
    expect(after.value.deleted).toBe(before.value.deleted + 1);
  });
});

describe("listUsers", () => {
  it("一覧が返る", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    await seedPlainUser({ id: "usr_a", username: "alice", email: "alice@example.com" });

    const result = await rpc.listUsers({ actorUserId: admin.userId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.users.some((u) => u.id === "usr_a")).toBe(true);
  });
});

describe("getUser", () => {
  it("userId 1 本で 1 人を返す（一覧を経由しない）", async () => {
    await seedPlainUser({ id: "usr_taro", username: "taro", email: "taro@example.com" });

    const result = await rpc.getUser({ actorUserId: "usr_admin", userId: "usr_taro" });

    expect(result.ok, "getUser が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe("usr_taro");
    expect(result.value.username).toBe("taro");
    expect(result.value.primaryEmail).toBe("taro@example.com");
    expect(result.value.status).toBe("active");
  });

  it("存在しない userId は not_found", async () => {
    const result = await rpc.getUser({ actorUserId: "usr_admin", userId: "usr_missing" });

    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("停止中の利用者も返す（止まっている人こそ確かめたい）", async () => {
    await seedPlainUser({
      id: "usr_stopped",
      username: "stopped",
      email: "stopped@example.com",
      status: "suspended",
    });

    const result = await rpc.getUser({ actorUserId: "usr_admin", userId: "usr_stopped" });

    expect(result.ok && result.value.status).toBe("suspended");
  });

  it("読み取りなので、実在しない actorUserId でも通る（listUsers と同じ扱い）", async () => {
    // **書く操作との非対称**（このファイルの冒頭を参照）。監査ログへ
    // `actorUserId` を書かないので、実在を確かめる理由が無い。
    await seedPlainUser({ id: "usr_taro", username: "taro", email: "taro@example.com" });

    const result = await rpc.getUser({ actorUserId: "usr_does_not_exist", userId: "usr_taro" });

    expect(result.ok).toBe(true);
  });

  it("監査ログに 1 行も書かない", async () => {
    await seedPlainUser({ id: "usr_taro", username: "taro", email: "taro@example.com" });

    await rpc.getUser({ actorUserId: "usr_admin", userId: "usr_taro" });

    const rows = await db().select().from(auditLogs).all();
    expect(rows).toHaveLength(0);
  });
});

describe("getUsersByIds", () => {
  it("見つかった分だけ、ID で引いた順ではなく見つかった順に返す", async () => {
    await seedPlainUser({ id: "usr_taro", username: "taro", email: "taro@example.com" });
    await seedPlainUser({ id: "usr_hanako", username: "hanako", email: "hanako@example.com" });

    const result = await rpc.getUsersByIds({
      actorUserId: "usr_admin",
      userIds: ["usr_taro", "usr_hanako"],
    });

    expect(result.ok, "getUsersByIds が失敗した").toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.value.map((u) => [u.id, u]));
    expect(byId.get("usr_taro")?.displayName).toBe("名前 taro");
    expect(byId.get("usr_hanako")?.username).toBe("hanako");
  });

  it("primaryEmail を持たない（UserAdminSummary を使い回さない、RR-13）", async () => {
    await seedPlainUser({ id: "usr_taro", username: "taro", email: "taro@example.com" });

    const result = await rpc.getUsersByIds({
      actorUserId: "usr_admin",
      userIds: ["usr_taro"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).not.toHaveProperty("primaryEmail");
  });

  it("見つからない ID が混ざっても落ちない。見つかった分だけ返る", async () => {
    await seedPlainUser({ id: "usr_taro", username: "taro", email: "taro@example.com" });

    const result = await rpc.getUsersByIds({
      actorUserId: "usr_admin",
      userIds: ["usr_taro", "usr_does_not_exist"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((u) => u.id)).toEqual(["usr_taro"]);
  });

  it("空配列なら空配列（失敗ではない）", async () => {
    const result = await rpc.getUsersByIds({ actorUserId: "usr_admin", userIds: [] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("101 件は invalid_input（上限 100）", async () => {
    const userIds = Array.from({ length: 101 }, (_, i) => `usr_${i}`);

    const result = await rpc.getUsersByIds({ actorUserId: "usr_admin", userIds });

    expect(!result.ok && result.error.code).toBe("invalid_input");
  });

  it("読み取りなので、実在しない actorUserId でも通る（getUser と同じ扱い）", async () => {
    await seedPlainUser({ id: "usr_taro", username: "taro", email: "taro@example.com" });

    const result = await rpc.getUsersByIds({
      actorUserId: "usr_does_not_exist",
      userIds: ["usr_taro"],
    });

    expect(result.ok).toBe(true);
  });

  it("監査ログに 1 行も書かない", async () => {
    await seedPlainUser({ id: "usr_taro", username: "taro", email: "taro@example.com" });

    await rpc.getUsersByIds({ actorUserId: "usr_admin", userIds: ["usr_taro"] });

    const rows = await db().select().from(auditLogs).all();
    expect(rows).toHaveLength(0);
  });
});

describe("getOAuthClient（#473）", () => {
  it("clientId 1 本で 1 件を返す（一覧を経由しない）", async () => {
    await seedClient({ clientId: "app_detail", clientType: "confidential", isFirstParty: false });

    const result = await rpc.getOAuthClient({ actorUserId: "usr_admin", clientId: "app_detail" });

    expect(result.ok, "getOAuthClient が失敗した").toBe(true);
    if (!result.ok) return;
    expect(result.value.clientId).toBe("app_detail");
    expect(result.value.clientType).toBe("confidential");
  });

  it("存在しない clientId は not_found", async () => {
    const result = await rpc.getOAuthClient({
      actorUserId: "usr_admin",
      clientId: "app_missing",
    });

    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("失効済みクライアントも返す（存在しないのと失効しているのを区別する）", async () => {
    await seedClient({
      clientId: "app_disabled",
      clientType: "confidential",
      isFirstParty: false,
      disabledAt: new Date(),
    });

    const result = await rpc.getOAuthClient({
      actorUserId: "usr_admin",
      clientId: "app_disabled",
    });

    expect(result.ok && result.value.disabledAt).not.toBeNull();
  });

  it("読み取りなので、実在しない actorUserId でも通る（listOAuthClients と同じ扱い）", async () => {
    await seedClient({ clientId: "app_detail", clientType: "public", isFirstParty: false });

    const result = await rpc.getOAuthClient({
      actorUserId: "usr_does_not_exist",
      clientId: "app_detail",
    });

    expect(result.ok).toBe(true);
  });

  it("監査ログに 1 行も書かない", async () => {
    await seedClient({ clientId: "app_detail", clientType: "public", isFirstParty: false });

    await rpc.getOAuthClient({ actorUserId: "usr_admin", clientId: "app_detail" });

    const rows = await db().select().from(auditLogs).all();
    expect(rows).toHaveLength(0);
  });
});

describe("suspendUser / reinstateUser / revokeUserSessions", () => {
  it("停止でき、理由が監査へ残る", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const target: SeededUser = await seedLoggedInUser();

    const result = await rpc.suspendUser({
      actorUserId: admin.userId,
      userId: target.userId,
      reason: "abuse",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revokedSessions).toBeGreaterThan(0);

    const row = await db().select().from(users).where(eq(users.id, target.userId)).get();
    expect(row?.status).toBe("suspended");

    const rows = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, "ops.user.suspended"))
      .all();
    expect(rows).toHaveLength(1);
    const metadata = (rows[0]?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata["reason"]).toBe("abuse");
    expect(metadata["actorUserId"]).toBe(admin.userId);
  });

  it("自分は止められない（actorUserId === userId）", async () => {
    const admin: SeededUser = await seedLoggedInUser();

    const result = await rpc.suspendUser({
      actorUserId: admin.userId,
      userId: admin.userId,
      reason: "abuse",
    });

    expect(!result.ok && result.error.code).toBe("conflict");
  });

  it("停止を解除できる", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const target: SeededUser = await seedLoggedInUser();
    await rpc.suspendUser({ actorUserId: admin.userId, userId: target.userId, reason: "abuse" });

    const result = await rpc.reinstateUser({ actorUserId: admin.userId, userId: target.userId });

    expect(result.ok).toBe(true);
    const row = await db().select().from(users).where(eq(users.id, target.userId)).get();
    expect(row?.status).toBe("active");
  });

  it("セッションの失効は自分に対しても許す", async () => {
    const admin: SeededUser = await seedLoggedInUser();

    const result = await rpc.revokeUserSessions({
      actorUserId: admin.userId,
      userId: admin.userId,
    });

    expect(result.ok).toBe(true);
  });

  it("再認証は要求しない（admin-worker 側の責務のため、seedLoggedInUser の authTime を問わない）", async () => {
    const STALE = new Date(Date.now() - 60 * 60 * 1000);
    const admin: SeededUser = await seedLoggedInUser({ authTime: STALE });
    const target: SeededUser = await seedLoggedInUser();

    const result = await rpc.suspendUser({
      actorUserId: admin.userId,
      userId: target.userId,
      reason: "abuse",
    });

    // `ManageUserUseCase` 相当の `reauthentication_required` は出ない。
    expect(result.ok).toBe(true);
  });
});

describe("deleteUser（物理削除、運用者判断 2026-11-08）", () => {
  it("削除でき、行が実際に消える（レスポンスではなく DB で確認する）", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const target: SeededUser = await seedLoggedInUser();

    const result = await rpc.deleteUser({ actorUserId: admin.userId, userId: target.userId });

    expect(result.ok).toBe(true);
    const row = await db().select().from(users).where(eq(users.id, target.userId)).get();
    expect(row).toBeUndefined();
  });

  it("自分自身は削除できない（conflict）", async () => {
    const admin: SeededUser = await seedLoggedInUser();

    const result = await rpc.deleteUser({ actorUserId: admin.userId, userId: admin.userId });

    expect(!result.ok && result.error.code).toBe("conflict");
    // 自分自身への conflict では、本人の行は消えずに残る。
    const row = await db().select().from(users).where(eq(users.id, admin.userId)).get();
    expect(row).toBeDefined();
  });

  it("存在しない userId は not_found", async () => {
    const admin: SeededUser = await seedLoggedInUser();

    const result = await rpc.deleteUser({
      actorUserId: admin.userId,
      userId: "usr_does_not_exist",
    });

    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("削除は監査に残る。userId は対象者本人、実行者は metadata", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const target: SeededUser = await seedLoggedInUser();

    await rpc.deleteUser({ actorUserId: admin.userId, userId: target.userId });

    const rows = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, "ops.user.deleted"))
      .all();
    expect(rows).toHaveLength(1);
    // **`oauth.client.disabled` とは逆。** ここでは対象者本人の id が
    // `userId` に入る——物理削除後は `users` の行が消えるので、これが
    // 「この id は削除された」と後から辿れる唯一の手段になる。
    expect(rows[0]?.userId).toBe(target.userId);
    const metadata = (rows[0]?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata["actorUserId"]).toBe(admin.userId);
  });

  it("存在しない userId への削除は監査に残らない（oauth.client.* の「何も起きなかった呼び出しも残す」とは違う）", async () => {
    const admin: SeededUser = await seedLoggedInUser();

    await rpc.deleteUser({ actorUserId: admin.userId, userId: "usr_does_not_exist" });

    const rows = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, "ops.user.deleted"))
      .all();
    expect(rows).toHaveLength(0);
  });

  it("クライアントを所有している利用者の削除が成功する（owner_user_id が null になり、クライアントは残る）", async () => {
    // **ここを測らないと、FK で落ちる経路が本番で初めて出る。**
    const admin: SeededUser = await seedLoggedInUser();
    const target: SeededUser = await seedLoggedInUser();
    const client = await seedClient({
      clientId: "owned-by-target",
      clientType: "public",
      isFirstParty: false,
    });
    await db()
      .update(oauthClients)
      .set({ ownerUserId: target.userId })
      .where(eq(oauthClients.id, client.id))
      .run();

    // 明示的に強制する。無いと FK 違反が起きず、この検査が「owner が
    // 残っていても消せる」ことを偶然を装って通すだけになる
    // （3b の指摘、2026-11-08。`session-repository.test.ts` 等と同じ理由）。
    await env.IDENTITY_DB.prepare("pragma foreign_keys = on").run();

    const result = await rpc.deleteUser({ actorUserId: admin.userId, userId: target.userId });

    expect(result.ok).toBe(true);
    const row = await db().select().from(oauthClients).where(eq(oauthClients.id, client.id)).get();
    expect(row).toBeDefined();
    expect(row?.ownerUserId).toBeNull();
  });
});

describe("createOAuthClient / disableOAuthClient", () => {
  it("登録でき、isFirstParty は常に false", async () => {
    const admin: SeededUser = await seedLoggedInUser();

    const result = await rpc.createOAuthClient({
      actorUserId: admin.userId,
      name: "admin-worker から登録",
      clientType: "confidential",
      redirectUris: ["https://app.example/cb"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.client.isFirstParty).toBe(false);
    expect(result.value.client.clientId).toMatch(/^app_/);
    expect(typeof result.value.clientSecret).toBe("string");
  });

  it("不正な redirect_uri は invalid_input で、1 行も増えない", async () => {
    const admin: SeededUser = await seedLoggedInUser();

    const result = await rpc.createOAuthClient({
      actorUserId: admin.userId,
      name: "x",
      clientType: "public",
      redirectUris: ["http://cdn.example/cb"],
    });

    expect(!result.ok && result.error.code).toBe("invalid_input");
    expect(await db().select().from(oauthClients).all()).toHaveLength(0);
  });

  it("失効でき、一次パーティは失効させられない", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const created = await rpc.createOAuthClient({
      actorUserId: admin.userId,
      name: "x",
      clientType: "public",
      redirectUris: ["https://app.example/cb"],
    });
    if (!created.ok) throw new Error("登録に失敗した");

    const disabled = await rpc.disableOAuthClient({
      actorUserId: admin.userId,
      clientId: created.value.client.clientId,
    });
    expect(disabled.ok && disabled.value.disabled).toBe(true);

    await db()
      .insert(oauthClients)
      .values({
        id: "cli_first_party_delegated",
        clientId: "u18-dashboard-delegated",
        name: "u18 Dashboard",
        clientType: "confidential",
        allowedScopes: "openid profile email",
        isFirstParty: true,
        logoUrl: null,
      })
      .run();

    const blocked = await rpc.disableOAuthClient({
      actorUserId: admin.userId,
      clientId: "u18-dashboard-delegated",
    });
    expect(!blocked.ok && blocked.error.code).toBe("conflict");
  });
});

describe("setOAuthClientOwner", () => {
  it("持ち主を設定でき、一覧にも反映される", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const owner: SeededUser = await seedLoggedInUser();
    const created = await rpc.createOAuthClient({
      actorUserId: admin.userId,
      name: "x",
      clientType: "public",
      redirectUris: ["https://app.example/cb"],
    });
    if (!created.ok) throw new Error("登録に失敗した");

    const result = await rpc.setOAuthClientOwner({
      actorUserId: admin.userId,
      clientId: created.value.client.clientId,
      ownerUserId: owner.userId,
    });

    expect(result.ok).toBe(true);
    const list = await rpc.listOAuthClients({ actorUserId: admin.userId });
    const updated = list.ok
      ? list.value.find((c) => c.clientId === created.value.client.clientId)
      : undefined;
    expect(updated?.ownerUserId).toBe(owner.userId);
  });

  it("null を渡すと持ち主を外せる", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const owner: SeededUser = await seedLoggedInUser();
    const created = await rpc.createOAuthClient({
      actorUserId: admin.userId,
      name: "x",
      clientType: "public",
      redirectUris: ["https://app.example/cb"],
    });
    if (!created.ok) throw new Error("登録に失敗した");
    await rpc.setOAuthClientOwner({
      actorUserId: admin.userId,
      clientId: created.value.client.clientId,
      ownerUserId: owner.userId,
    });

    const result = await rpc.setOAuthClientOwner({
      actorUserId: admin.userId,
      clientId: created.value.client.clientId,
      ownerUserId: null,
    });

    expect(result.ok).toBe(true);
    const list = await rpc.listOAuthClients({ actorUserId: admin.userId });
    const updated = list.ok
      ? list.value.find((c) => c.clientId === created.value.client.clientId)
      : undefined;
    expect(updated?.ownerUserId).toBeNull();
  });

  it("実在しない ownerUserId は invalid_input で弾く（行は変わらない）", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const created = await rpc.createOAuthClient({
      actorUserId: admin.userId,
      name: "x",
      clientType: "public",
      redirectUris: ["https://app.example/cb"],
    });
    if (!created.ok) throw new Error("登録に失敗した");

    const result = await rpc.setOAuthClientOwner({
      actorUserId: admin.userId,
      clientId: created.value.client.clientId,
      ownerUserId: "usr_does_not_exist",
    });

    expect(!result.ok && result.error.code).toBe("invalid_input");
    const row = await db()
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, created.value.client.clientId))
      .get();
    expect(row?.ownerUserId).toBeNull();
  });

  it("未登録の client_id は not_found", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const owner: SeededUser = await seedLoggedInUser();

    const result = await rpc.setOAuthClientOwner({
      actorUserId: admin.userId,
      clientId: "u18-never-existed",
      ownerUserId: owner.userId,
    });

    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("監査に前後の値が残り、氏名・メールアドレスは含まれない", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const owner: SeededUser = await seedLoggedInUser();
    const created = await rpc.createOAuthClient({
      actorUserId: admin.userId,
      name: "x",
      clientType: "public",
      redirectUris: ["https://app.example/cb"],
    });
    if (!created.ok) throw new Error("登録に失敗した");

    await rpc.setOAuthClientOwner({
      actorUserId: admin.userId,
      clientId: created.value.client.clientId,
      ownerUserId: owner.userId,
    });

    const rows = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, "oauth.client.owner_changed"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "success", userId: admin.userId });
    const metadata = rows[0]?.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      clientId: created.value.client.clientId,
      previousOwnerUserId: null,
      newOwnerUserId: owner.userId,
    });
    expect(JSON.stringify(rows[0])).not.toContain(owner.username);
  });
});

describe("setOAuthClientAppUrl", () => {
  it("表示用 URL を設定でき、一覧にも反映される", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const created = await rpc.createOAuthClient({
      actorUserId: admin.userId,
      name: "x",
      clientType: "public",
      redirectUris: ["https://app.example/cb"],
    });
    if (!created.ok) throw new Error("登録に失敗した");

    const result = await rpc.setOAuthClientAppUrl({
      actorUserId: admin.userId,
      clientId: created.value.client.clientId,
      appUrl: "https://app.example/",
    });

    expect(result.ok).toBe(true);
    const list = await rpc.listOAuthClients({ actorUserId: admin.userId });
    const updated = list.ok
      ? list.value.find((c) => c.clientId === created.value.client.clientId)
      : undefined;
    expect(updated?.appUrl).toBe("https://app.example/");
  });

  it("null を渡すと外せる", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const created = await rpc.createOAuthClient({
      actorUserId: admin.userId,
      name: "x",
      clientType: "public",
      redirectUris: ["https://app.example/cb"],
    });
    if (!created.ok) throw new Error("登録に失敗した");
    await rpc.setOAuthClientAppUrl({
      actorUserId: admin.userId,
      clientId: created.value.client.clientId,
      appUrl: "https://app.example/",
    });

    const result = await rpc.setOAuthClientAppUrl({
      actorUserId: admin.userId,
      clientId: created.value.client.clientId,
      appUrl: null,
    });

    expect(result.ok).toBe(true);
    const list = await rpc.listOAuthClients({ actorUserId: admin.userId });
    const updated = list.ok
      ? list.value.find((c) => c.clientId === created.value.client.clientId)
      : undefined;
    expect(updated?.appUrl).toBeNull();
  });

  it.each([
    ["平文 HTTP", "http://app.example/"],
    ["data: スキーム", "data:text/html,hi"],
    ["資格情報付き", "https://user:pass@app.example/"],
    ["絶対 URI でない", "/app"],
  ])("不正な appUrl（%s）は invalid_input で弾く（行は変わらない）", async (_label, appUrl) => {
    const admin: SeededUser = await seedLoggedInUser();
    const created = await rpc.createOAuthClient({
      actorUserId: admin.userId,
      name: "x",
      clientType: "public",
      redirectUris: ["https://app.example/cb"],
    });
    if (!created.ok) throw new Error("登録に失敗した");

    const result = await rpc.setOAuthClientAppUrl({
      actorUserId: admin.userId,
      clientId: created.value.client.clientId,
      appUrl,
    });

    expect(!result.ok && result.error.code).toBe("invalid_input");
    const row = await db()
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, created.value.client.clientId))
      .get();
    expect(row?.appUrl).toBeNull();
  });

  it("未登録の client_id は not_found", async () => {
    const admin: SeededUser = await seedLoggedInUser();

    const result = await rpc.setOAuthClientAppUrl({
      actorUserId: admin.userId,
      clientId: "u18-never-existed",
      appUrl: "https://app.example/",
    });

    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("監査に前後の値が残り、standard 区分である", async () => {
    const admin: SeededUser = await seedLoggedInUser();
    const created = await rpc.createOAuthClient({
      actorUserId: admin.userId,
      name: "x",
      clientType: "public",
      redirectUris: ["https://app.example/cb"],
    });
    if (!created.ok) throw new Error("登録に失敗した");

    await rpc.setOAuthClientAppUrl({
      actorUserId: admin.userId,
      clientId: created.value.client.clientId,
      appUrl: "https://app.example/",
    });

    const rows = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, "oauth.client.app_url_changed"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "success", userId: admin.userId });
    const metadata = rows[0]?.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      clientId: created.value.client.clientId,
      previousAppUrl: null,
      newAppUrl: "https://app.example/",
    });
  });
});

describe("listAuditLogs の category 絞り込み（#515）", () => {
  async function seedAuditRow(fields: {
    id: string;
    event: string;
    createdAt: Date;
  }): Promise<void> {
    await db()
      .insert(auditLogs)
      .values({
        id: fields.id,
        event: fields.event,
        outcome: "success",
        createdAt: fields.createdAt,
      })
      .run();
  }

  it("ログイン等の量が多いイベントに流されず、運営の操作だけを返す", async () => {
    const admin: SeededUser = await seedLoggedInUser();

    // **ログインの方が新しい。** 絞り込みが無ければ、こちらが先頭に来て
    // `ops.user.suspended` は limit 5 から押し出される——#515 そのものの
    // 再現。
    await seedAuditRow({
      id: "aud_ops_1",
      event: "ops.user.suspended",
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    for (let i = 0; i < 5; i++) {
      await seedAuditRow({
        id: `aud_login_${i}`,
        event: "passkey.login",
        createdAt: new Date(`2026-11-0${2 + i}T00:00:00.000Z`),
      });
    }

    const unfiltered = await rpc.listAuditLogs({ actorUserId: admin.userId, limit: 5 });
    expect(unfiltered.ok).toBe(true);
    if (unfiltered.ok) {
      // **絞り込み無しだと実際に流される**ことを先に固定する——このテストの
      // 前提（#515 の再現）が崩れていないことの確認。
      expect(unfiltered.value.entries.some((e) => e.event === "ops.user.suspended")).toBe(false);
    }

    const filtered = await rpc.listAuditLogs({
      actorUserId: admin.userId,
      category: "operator_action",
      limit: 5,
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.value.entries.map((e) => e.event)).toEqual(["ops.user.suspended"]);
  });

  it("oauth.client.authenticate / oauth.client.resolve は量が多くても絞り込みに混ざらない", async () => {
    const admin: SeededUser = await seedLoggedInUser();

    await seedAuditRow({
      id: "aud_owner_changed",
      event: "oauth.client.owner_changed",
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    for (let i = 0; i < 5; i++) {
      await seedAuditRow({
        id: `aud_authn_${i}`,
        event: "oauth.client.authenticate",
        createdAt: new Date(`2026-11-0${2 + i}T00:00:00.000Z`),
      });
    }

    const result = await rpc.listAuditLogs({
      actorUserId: admin.userId,
      category: "operator_action",
      limit: 5,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((e) => e.event)).toEqual(["oauth.client.owner_changed"]);
  });
});

describe("IdentityAdminRpcContract（dashboard 向け）は影響を受けない", () => {
  it("sessionToken 必須のままである（delegated 契約が型で混ざっていない）", async () => {
    const { IdentityAdminRPC } = await import("../src/presentation/rpc/identity-admin.entrypoint");
    const dashboardRpc = new IdentityAdminRPC(createExecutionContext(), appEnv());

    // sessionToken を欠いた入力は invalid_input になる（型は any 経由）。
    const result = await dashboardRpc.listUsers({ caller: "dashboard-worker" } as never);

    expect(!result.ok && result.error.code).toBe("invalid_input");
    void CALLER;
  });
});
