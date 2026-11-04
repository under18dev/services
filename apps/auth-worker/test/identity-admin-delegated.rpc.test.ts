import { auditLogs, oauthClients, users } from "@u18/db";
import { createExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { IdentityAdminDelegatedRPC } from "../src/presentation/rpc/identity-admin-delegated.entrypoint";
import { resetDatabase } from "./helpers";
import { appEnv, db, seedLoggedInUser, type SeededUser } from "./helpers.oauth";

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

  it("読み取り（listUsers / listOAuthClients / countOAuthClients / listAuditLogs）は実在確認すら求めない", async () => {
    // 読み取りは `actorUserId` を監査へ書かないので、確かめる理由も無い
    // （書く操作とは非対称。`DelegatedListUsersUseCase` の JSDoc 参照）。
    const users1 = await rpc.listUsers({ actorUserId: "usr_does_not_exist" });
    const clients1 = await rpc.listOAuthClients({ actorUserId: "usr_does_not_exist" });
    const count1 = await rpc.countOAuthClients({ actorUserId: "usr_does_not_exist" });
    const logs1 = await rpc.listAuditLogs({ actorUserId: "usr_does_not_exist" });

    expect(users1.ok).toBe(true);
    expect(clients1.ok).toBe(true);
    expect(count1.ok).toBe(true);
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
