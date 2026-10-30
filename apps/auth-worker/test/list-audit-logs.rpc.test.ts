import { auditLogs } from "@u18/db";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { IdentityAdminRPC } from "../src/presentation/rpc/identity-admin.entrypoint";
import { resetDatabase } from "./helpers";
import { appEnv, db, seedLoggedInUser, type SeededUser } from "./helpers.oauth";

/**
 * 監査ログの閲覧（#375 / #382）。
 *
 * ## ここでしか確かめられないこと
 *
 * 1. **壁が先、カーソルの検査が後。** `ListUsersUseCase` と同じ順序の
 *    検査。逆だと、`invalid_input` と `not_found` の出し分けから
 *    「管理者かどうか」が読める
 * 2. **`ipHash` が載ること。** `SessionListItem` が意図的に外しているので、
 *    別の DTO（`AuditLogEntryAdmin`）で初めて出る値
 * 3. **絞り込みが AND で効くこと**
 * 4. **空のページが 1 回増えない**（`keyset-cursor.ts` の共通処理）
 */

const rpc = new IdentityAdminRPC(createExecutionContext(), appEnv());
const CALLER = "dashboard-worker" as const;

function seedAdmin(): Promise<SeededUser> {
  return seedLoggedInUser({ isAdmin: true, authMethod: "passkey" });
}

async function seedRow(fields: {
  id: string;
  event: string;
  userId?: string | null;
  outcome?: "success" | "failure";
  createdAt: Date;
  ipHash?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  await db()
    .insert(auditLogs)
    .values({
      id: fields.id,
      event: fields.event,
      userId: fields.userId ?? null,
      outcome: fields.outcome ?? "success",
      createdAt: fields.createdAt,
      ipHash: fields.ipHash ?? null,
      metadata: fields.metadata ?? null,
    })
    .run();
}

beforeEach(resetDatabase);

describe("listAuditLogs の壁", () => {
  it("一般利用者には not_found", async () => {
    const user = await seedLoggedInUser();

    const result = await rpc.listAuditLogs({ sessionToken: user.sessionToken, caller: CALLER });

    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("旗が立っていても、OTP のセッションでは通らない（決定 8 / RR-5）", async () => {
    const user = await seedLoggedInUser({ isAdmin: true, authMethod: "email_otp" });

    const result = await rpc.listAuditLogs({ sessionToken: user.sessionToken, caller: CALLER });

    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("一般利用者が壊れたカーソルで来ても not_found（壁が先）", async () => {
    // 順序の検査。逆だと `invalid_input` と `not_found` の出し分けから
    // 管理者かどうかが読める。
    const user = await seedLoggedInUser();

    const result = await rpc.listAuditLogs({
      sessionToken: user.sessionToken,
      caller: CALLER,
      cursor: "not-a-cursor",
    });

    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("管理者でも、壊れたカーソルは invalid_input（黙って先頭へ戻さない）", async () => {
    const admin = await seedAdmin();

    const result = await rpc.listAuditLogs({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      cursor: "not-a-cursor",
    });

    expect(!result.ok && result.error.code).toBe("invalid_input");
  });
});

describe("listAuditLogs が返すもの", () => {
  it("ipHash が載る（SessionListItem は意図的に外している）", async () => {
    const admin = await seedAdmin();
    await seedRow({
      id: "aud_1",
      event: "session.issue",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      ipHash: "deadbeef",
    });

    const result = await rpc.listAuditLogs({ sessionToken: admin.sessionToken, caller: CALLER });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.value.entries.find((e) => e.id === "aud_1");
    expect(row?.ipHash).toBe("deadbeef");
  });

  it("metadata をそのまま返す（二重に選別しない）", async () => {
    const admin = await seedAdmin();
    await seedRow({
      id: "aud_1",
      event: "ops.user.suspended",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      metadata: { reason: "abuse", actorUserId: "usr_x" },
    });

    const result = await rpc.listAuditLogs({ sessionToken: admin.sessionToken, caller: CALLER });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries[0]?.metadata).toEqual({ reason: "abuse", actorUserId: "usr_x" });
  });

  it("新しい順に返る", async () => {
    const admin = await seedAdmin();
    await seedRow({ id: "aud_old", event: "x", createdAt: new Date("2026-01-01T00:00:00.000Z") });
    await seedRow({ id: "aud_new", event: "x", createdAt: new Date("2026-10-29T00:00:00.000Z") });

    const result = await rpc.listAuditLogs({ sessionToken: admin.sessionToken, caller: CALLER });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.entries.map((e) => e.id);
    expect(ids.indexOf("aud_new")).toBeLessThan(ids.indexOf("aud_old"));
  });

  it("event で絞り込める", async () => {
    const admin = await seedAdmin();
    await seedRow({
      id: "aud_a",
      event: "ops.user.suspended",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    await seedRow({
      id: "aud_b",
      event: "ops.user.reinstated",
      createdAt: new Date("2026-10-02T00:00:00.000Z"),
    });

    const result = await rpc.listAuditLogs({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      event: "ops.user.suspended",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((e) => e.id)).toEqual(["aud_a"]);
  });

  it("userId で絞り込める", async () => {
    const admin = await seedAdmin();
    await seedRow({
      id: "aud_a",
      event: "x",
      userId: "usr_target",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    await seedRow({
      id: "aud_b",
      event: "x",
      userId: "usr_other",
      createdAt: new Date("2026-10-02T00:00:00.000Z"),
    });

    const result = await rpc.listAuditLogs({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      userId: "usr_target",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((e) => e.id)).toEqual(["aud_a"]);
  });

  it("event と userId は AND で効く", async () => {
    const admin = await seedAdmin();
    await seedRow({
      id: "aud_match",
      event: "ops.user.suspended",
      userId: "usr_target",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    await seedRow({
      id: "aud_wrong_event",
      event: "ops.user.reinstated",
      userId: "usr_target",
      createdAt: new Date("2026-10-02T00:00:00.000Z"),
    });
    await seedRow({
      id: "aud_wrong_user",
      event: "ops.user.suspended",
      userId: "usr_other",
      createdAt: new Date("2026-10-03T00:00:00.000Z"),
    });

    const result = await rpc.listAuditLogs({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      event: "ops.user.suspended",
      userId: "usr_target",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((e) => e.id)).toEqual(["aud_match"]);
  });

  it("outcome で絞り込める", async () => {
    const admin = await seedAdmin();
    await seedRow({
      id: "aud_ok",
      event: "x",
      outcome: "success",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    await seedRow({
      id: "aud_fail",
      event: "x",
      outcome: "failure",
      createdAt: new Date("2026-10-02T00:00:00.000Z"),
    });

    const result = await rpc.listAuditLogs({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      outcome: "failure",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((e) => e.id)).toEqual(["aud_fail"]);
  });

  it("一致しないイベント名はエラーではなく 0 件", async () => {
    const admin = await seedAdmin();

    const result = await rpc.listAuditLogs({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      event: "no.such.event",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries).toEqual([]);
  });
});

describe("listAuditLogs のカーソル", () => {
  it("続きがあるときだけ返り、終端では null。空のページを挟まない", async () => {
    const admin = await seedAdmin();
    for (let i = 0; i < 4; i += 1) {
      await seedRow({ id: `aud_${i}`, event: "x", createdAt: new Date(Date.UTC(2026, 9, 1 + i)) });
    }

    const first = await rpc.listAuditLogs({
      sessionToken: admin.sessionToken,
      caller: CALLER,
      limit: 2,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.entries).toHaveLength(2);
    expect(first.value.nextCursor).not.toBeNull();

    const seen = new Set(first.value.entries.map((e) => e.id));
    let cursor = first.value.nextCursor;
    let guard = 0;
    while (cursor !== null && guard < 10) {
      const page = await rpc.listAuditLogs({
        sessionToken: admin.sessionToken,
        caller: CALLER,
        limit: 2,
        cursor,
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      // **空のページを返さない。** 件数が limit の倍数のとき、
      // 「ちょうど limit 件あったか」で続きを決めると最後に 1 回空のページが
      // 増える（#375 のネガティブ確認ですり抜けた形。keyset-cursor.ts で手当て）。
      expect(page.value.entries.length).toBeGreaterThan(0);
      for (const e of page.value.entries) {
        expect(seen.has(e.id)).toBe(false);
        seen.add(e.id);
      }
      cursor = page.value.nextCursor;
      guard += 1;
    }

    expect(cursor).toBeNull();
    expect(seen.size).toBe(4);
  });
});

describe("listAuditLogs は新しい行を作らない", () => {
  it("成功しても拒否しても audit_logs の行数は増えない", async () => {
    const admin = await seedAdmin();
    const user = await seedLoggedInUser();
    const before = (await db().select().from(auditLogs).all()).length;

    await rpc.listAuditLogs({ sessionToken: admin.sessionToken, caller: CALLER });
    await rpc.listAuditLogs({ sessionToken: user.sessionToken, caller: CALLER });

    expect((await db().select().from(auditLogs).all()).length).toBe(before);
  });
});
