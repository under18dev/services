import { adminApprovalEvents, adminApprovals, createAdminDatabase } from "@u18/admin-db";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { APPROVAL_AUDIT_EVENTS } from "../src/domain/approval-audit-events";
import {
  approvalAuditSql,
  approvalStatusSql,
  countSuperApproversSql,
  grantApprovalSql,
  listApprovalsSql,
  revokeApprovalSql,
  setPermissionsSql,
  sqlLiteral,
} from "../src/infrastructure/persistence/approval.sql";

/**
 * `scripts/admin-approval.mjs` が実際に流す文を、本物の D1 に対して確かめる
 * （`apps/auth-worker/test/admin-role.test.ts` と同じ方針）。
 *
 * **CLI は Node から `wrangler d1 execute` 越しにこの文字列を流すだけ**で、
 * CLI 自身のロジックに判定は無い。だから「文が正しく振る舞うか」を
 * ここで確かめれば、CLI の正しさも実質確かめたことになる。
 */

async function run(sql: string): Promise<readonly Record<string, unknown>[]> {
  const result = await env.ADMIN_DB.prepare(sql).all();
  return result.results;
}

beforeEach(async () => {
  const db = createAdminDatabase(env.ADMIN_DB);
  await db.delete(adminApprovalEvents).run();
  await db.delete(adminApprovals).run();
});

describe("grantApprovalSql", () => {
  it("新規なら行を作る", async () => {
    const rows = await run(grantApprovalSql("usr_a", false));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_super_approver).toBe(0);

    const status = await run(approvalStatusSql("usr_a"));
    expect(status).toHaveLength(1);
    expect(status[0]?.approved_by_sub).toBeNull();
  });

  it("既存なら is_super_approver を更新する（UPSERT）", async () => {
    await run(grantApprovalSql("usr_a", false));
    const rows = await run(grantApprovalSql("usr_a", true));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_super_approver).toBe(1);

    // 行は増えていない（同じ sub のまま）。
    const all = await run(listApprovalsSql());
    expect(all).toHaveLength(1);
  });

  it("`'` を含む sub でも文が壊れない（SQL 注入対策）", async () => {
    const sub = "usr_o'brien";
    const rows = await run(grantApprovalSql(sub, false));
    expect(rows).toHaveLength(1);

    const status = await run(approvalStatusSql(sub));
    expect(status[0]?.sub).toBe(sub);
  });
});

describe("revokeApprovalSql", () => {
  it("承認済みなら削除して返す", async () => {
    await run(grantApprovalSql("usr_a", false));
    const revoked = await run(revokeApprovalSql("usr_a"));

    expect(revoked).toHaveLength(1);
    expect(await run(approvalStatusSql("usr_a"))).toHaveLength(0);
  });

  it("承認されていない sub は 0 行", async () => {
    expect(await run(revokeApprovalSql("usr_not_approved"))).toHaveLength(0);
  });
});

describe("listApprovalsSql", () => {
  it("古い順に全員を返す", async () => {
    await run(grantApprovalSql("usr_1", false));
    await run(grantApprovalSql("usr_2", true));

    const rows = await run(listApprovalsSql());
    expect(rows.map((row) => row.sub)).toEqual(["usr_1", "usr_2"]);
  });

  it("誰も居なければ 0 件", async () => {
    expect(await run(listApprovalsSql())).toEqual([]);
  });
});

describe("0002_backfill_existing_approvals_permissions.sql（#190）", () => {
  // **実際のマイグレーションファイルをそのまま流す。** コピーした SQL では
  // なく、本番が実行するのと同じ文字列（`vitest.config.ts` が Node 側で
  // 読んで渡している）を使う——ロジックを書き写すと、ファイルを直しても
  // テストが古いままになりうる。
  //
  // `setup.ts` は全マイグレーションを空の DB に適用済みなので、ここでは
  // 「移行より前から居た行」を再現するために、行を作ってからもう一度
  // 同じ SQL を流す。
  it("super も非 super も、既存の承認済み行は全ビットになる（今日できていたことを明日もできる）", async () => {
    await run(grantApprovalSql("usr_super", true));
    await run(grantApprovalSql("usr_plain", false));

    await env.ADMIN_DB.prepare(env.TEST_PERMISSIONS_BACKFILL_SQL).run();

    const rows = await run(listApprovalsSql());
    const permissions = Object.fromEntries(rows.map((row) => [row.sub, row.permissions]));
    expect(permissions["usr_super"]).toBe("255");
    expect(permissions["usr_plain"]).toBe("255");
  });

  it("255 は 8 ビット全部（NFC_READ〜APPROVAL_GRANT）", () => {
    // マイグレーションの SQL はハードコードされた定数なので、`permissions.ts`
    // の定義とここで独立に突き合わせる——どちらかだけ直すと気づけない。
    expect(255).toBe(2 ** 8 - 1);
  });
});

describe("countSuperApproversSql", () => {
  it("super が居なければ 0", async () => {
    await run(grantApprovalSql("usr_a", false));
    const rows = await run(countSuperApproversSql());
    expect(rows[0]?.count).toBe(0);
  });

  it("super の人数だけを数える（非 super は数えない）", async () => {
    await run(grantApprovalSql("usr_a", false));
    await run(grantApprovalSql("usr_b", true));
    await run(grantApprovalSql("usr_c", true));
    const rows = await run(countSuperApproversSql());
    expect(rows[0]?.count).toBe(2);
  });
});

describe("setPermissionsSql", () => {
  it("permissions を書き換える", async () => {
    await run(grantApprovalSql("usr_a", false));
    const rows = await run(setPermissionsSql("usr_a", "5"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.permissions).toBe("5");

    const status = await run(approvalStatusSql("usr_a"));
    expect(status[0]?.permissions).toBe("5");
  });

  it("承認されていない sub は 0 行", async () => {
    expect(await run(setPermissionsSql("usr_not_approved", "1"))).toHaveLength(0);
  });
});

describe("approvalAuditSql", () => {
  it("承認・剥奪の記録を残す", async () => {
    await run(
      approvalAuditSql({
        event: APPROVAL_AUDIT_EVENTS.granted.event,
        sub: "usr_a",
        actor: "github-handle",
        reason: "manual_grant",
      }),
    );

    const events = await run(
      `select * from admin_approval_events where sub = ${sqlLiteral("usr_a")};`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("ops.approval.granted");
    expect(events[0]?.actor).toBe("github-handle");
  });

  it("実行者を伏せない（u18 Identity の sub ではなく自由文字列として残る）", async () => {
    // **ここが CLI の約束。** actor は常に埋まる——ブートストラップでも
    // `--actor` が必須なので、null を記録する経路は無い。
    await run(
      approvalAuditSql({
        event: APPROVAL_AUDIT_EVENTS.granted.event,
        sub: "usr_bootstrap",
        actor: "operator-handle",
        reason: "bootstrap",
      }),
    );

    const events = await run(
      `select actor from admin_approval_events where sub = ${sqlLiteral("usr_bootstrap")};`,
    );
    expect(events[0]?.actor).toBe("operator-handle");
  });

  it("承認そのものの付与・剥奪では detail が null", async () => {
    await run(
      approvalAuditSql({
        event: APPROVAL_AUDIT_EVENTS.granted.event,
        sub: "usr_a",
        actor: "github-handle",
        reason: "manual_grant",
      }),
    );
    const events = await run(
      `select detail from admin_approval_events where sub = ${sqlLiteral("usr_a")};`,
    );
    expect(events[0]?.detail).toBeNull();
  });

  it("権限ビットの変更は、生の数値ではなくビットの記号名を detail に残す（#190）", () => {
    const sql = approvalAuditSql({
      event: APPROVAL_AUDIT_EVENTS.permissionGranted.event,
      sub: "usr_a",
      actor: "github-handle",
      reason: "manual_grant",
      detail: "NFC_WRITE",
    });
    expect(sql).toContain("NFC_WRITE");
  });

  it("権限ビットの変更が実際に detail 列へ記号名のまま残る", async () => {
    await run(
      approvalAuditSql({
        event: APPROVAL_AUDIT_EVENTS.permissionGranted.event,
        sub: "usr_a",
        actor: "github-handle",
        reason: "manual_grant",
        detail: "NFC_WRITE",
      }),
    );
    const events = await run(
      `select event, detail from admin_approval_events where sub = ${sqlLiteral("usr_a")};`,
    );
    expect(events[0]?.event).toBe("ops.permission.granted");
    expect(events[0]?.detail).toBe("NFC_WRITE");
  });
});
