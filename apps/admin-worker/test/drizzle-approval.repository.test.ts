import { adminApprovalEvents, adminApprovals, createAdminDatabase } from "@u18/admin-db";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DrizzleApprovalRepository } from "../src/infrastructure/persistence/drizzle-approval.repository";

/**
 * `/approvals` 画面（#190）が実際に通す書き込み経路を、本物の D1 に対して
 * 確かめる。`approval.sql.test.ts` は CLI が流す SQL 文字列を見ているが、
 * こちらは Worker 側が Drizzle 経由で書く別の経路——2 つの経路が同じ
 * スキーマに対して正しく振る舞うことを、それぞれ独立に固定する。
 */

function db() {
  return createAdminDatabase(env.ADMIN_DB);
}

beforeEach(async () => {
  const d = db();
  await d.delete(adminApprovalEvents).run();
  await d.delete(adminApprovals).run();
});

describe("grant", () => {
  it("新規なら行を作る（permissions は 0 から始まる）", async () => {
    const repo = new DrizzleApprovalRepository(db());
    const result = await repo.grant("usr_a", false, "usr_granter");

    expect(result.isSuperApprover).toBe(false);
    const row = await repo.getBySub("usr_a");
    expect(row?.permissions).toBe(0n);
    expect(row?.approvedBySub).toBe("usr_granter");
  });

  it("既存なら isSuperApprover を更新する（UPSERT、permissions は保つ）", async () => {
    const repo = new DrizzleApprovalRepository(db());
    await repo.grant("usr_a", false, null);
    await repo.setPermissions("usr_a", 5n);

    const result = await repo.grant("usr_a", true, null);

    expect(result.isSuperApprover).toBe(true);
    const row = await repo.getBySub("usr_a");
    expect(row?.isSuperApprover).toBe(true);
    expect(row?.permissions).toBe(5n); // 昇格で勝手に消えない
  });
});

describe("revoke", () => {
  it("承認済みなら削除して true を返す", async () => {
    const repo = new DrizzleApprovalRepository(db());
    await repo.grant("usr_a", false, null);

    expect(await repo.revoke("usr_a")).toBe(true);
    expect(await repo.getBySub("usr_a")).toBeNull();
  });

  it("承認されていない sub は false", async () => {
    const repo = new DrizzleApprovalRepository(db());
    expect(await repo.revoke("usr_not_approved")).toBe(false);
  });
});

describe("setPermissions", () => {
  it("permissions を書き換えて true を返す", async () => {
    const repo = new DrizzleApprovalRepository(db());
    await repo.grant("usr_a", false, null);

    expect(await repo.setPermissions("usr_a", 255n)).toBe(true);
    const row = await repo.getBySub("usr_a");
    expect(row?.permissions).toBe(255n);
  });

  it("承認されていない sub は false", async () => {
    const repo = new DrizzleApprovalRepository(db());
    expect(await repo.setPermissions("usr_not_approved", 1n)).toBe(false);
  });
});

describe("listAll / getBySub", () => {
  it("古い順に全員を返す", async () => {
    const repo = new DrizzleApprovalRepository(db());
    await repo.grant("usr_1", false, null);
    await repo.grant("usr_2", true, null);

    const rows = await repo.listAll();
    expect(rows.map((row) => row.sub)).toEqual(["usr_1", "usr_2"]);
  });

  it("誰も居なければ 0 件", async () => {
    const repo = new DrizzleApprovalRepository(db());
    expect(await repo.listAll()).toEqual([]);
  });
});

describe("recordAuditEvent", () => {
  it("ビットの記号名を detail へそのまま残す（生の数値にしない、#190）", async () => {
    const repo = new DrizzleApprovalRepository(db());
    await repo.recordAuditEvent({
      event: "ops.permission.granted",
      sub: "usr_a",
      actor: "usr_granter",
      reason: "UI から付与",
      detail: "NFC_WRITE",
    });

    const rows = await db().select().from(adminApprovalEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toBe("NFC_WRITE");
    expect(rows[0]?.actor).toBe("usr_granter");
  });

  it("承認そのものの付与・剥奪は detail が無い", async () => {
    const repo = new DrizzleApprovalRepository(db());
    await repo.recordAuditEvent({
      event: "ops.approval.granted",
      sub: "usr_a",
      actor: "usr_granter",
      reason: "UI から承認",
    });

    const rows = await db().select().from(adminApprovalEvents).all();
    expect(rows[0]?.detail).toBeNull();
  });
});
