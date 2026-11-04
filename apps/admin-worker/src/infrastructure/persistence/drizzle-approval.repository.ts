import { adminApprovalEvents, adminApprovals, type AdminDatabase } from "@u18/admin-db";
import { newId } from "@u18/domain";
import { eq, sql } from "drizzle-orm";
import type {
  ApprovalListRow,
  ApprovalRepository,
} from "../../application/ports/approval.repository";
import {
  effectivePermissions,
  formatPermissions,
  parsePermissions,
  type EffectivePermissions,
} from "../../domain/permissions";

export class DrizzleApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: AdminDatabase) {}

  async isApproved(sub: string): Promise<boolean> {
    const row = await this.db
      .select({ id: adminApprovals.id })
      .from(adminApprovals)
      .where(eq(adminApprovals.sub, sub))
      .get();
    return row !== undefined;
  }

  async isSuperApprover(sub: string): Promise<boolean> {
    const row = await this.db
      .select({ isSuperApprover: adminApprovals.isSuperApprover })
      .from(adminApprovals)
      .where(eq(adminApprovals.sub, sub))
      .get();
    return row?.isSuperApprover ?? false;
  }

  async getEffectivePermissions(sub: string): Promise<EffectivePermissions | null> {
    const row = await this.db
      .select({
        isSuperApprover: adminApprovals.isSuperApprover,
        permissions: adminApprovals.permissions,
      })
      .from(adminApprovals)
      .where(eq(adminApprovals.sub, sub))
      .get();
    if (row === undefined) return null;
    return effectivePermissions({
      isSuperApprover: row.isSuperApprover,
      permissions: parsePermissions(row.permissions),
    });
  }

  async countSuperApprovers(): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(adminApprovals)
      .where(eq(adminApprovals.isSuperApprover, true))
      .get();
    return row?.count ?? 0;
  }

  async listAll(): Promise<readonly ApprovalListRow[]> {
    const rows = await this.db
      .select({
        sub: adminApprovals.sub,
        isSuperApprover: adminApprovals.isSuperApprover,
        permissions: adminApprovals.permissions,
        approvedBySub: adminApprovals.approvedBySub,
        createdAt: adminApprovals.createdAt,
      })
      .from(adminApprovals)
      .orderBy(adminApprovals.createdAt)
      .all();
    return rows.map((row) => ({ ...row, permissions: parsePermissions(row.permissions) }));
  }

  async getBySub(sub: string): Promise<ApprovalListRow | null> {
    const row = await this.db
      .select({
        sub: adminApprovals.sub,
        isSuperApprover: adminApprovals.isSuperApprover,
        permissions: adminApprovals.permissions,
        approvedBySub: adminApprovals.approvedBySub,
        createdAt: adminApprovals.createdAt,
      })
      .from(adminApprovals)
      .where(eq(adminApprovals.sub, sub))
      .get();
    return row === undefined ? null : { ...row, permissions: parsePermissions(row.permissions) };
  }

  async grant(
    sub: string,
    isSuperApprover: boolean,
    approvedBySub: string | null,
  ): Promise<{ readonly isSuperApprover: boolean }> {
    const rows = await this.db
      .insert(adminApprovals)
      .values({ id: newId("adm"), sub, isSuperApprover, approvedBySub })
      .onConflictDoUpdate({
        target: adminApprovals.sub,
        set: { isSuperApprover },
      })
      .returning({ isSuperApprover: adminApprovals.isSuperApprover });
    // insert ... on conflict do update は、新規行・更新行のどちらでも必ず
    // 1 行返す（`values` が 1 件なので）。0 行は起こり得ない。
    const row = rows[0];
    if (row === undefined) throw new Error("grant: UPSERT が 1 行も返さなかった（想定外）");
    return row;
  }

  async revoke(sub: string): Promise<boolean> {
    const rows = await this.db
      .delete(adminApprovals)
      .where(eq(adminApprovals.sub, sub))
      .returning({ id: adminApprovals.id });
    return rows.length > 0;
  }

  async setPermissions(sub: string, permissions: bigint): Promise<boolean> {
    const rows = await this.db
      .update(adminApprovals)
      .set({ permissions: formatPermissions(permissions) })
      .where(eq(adminApprovals.sub, sub))
      .returning({ id: adminApprovals.id });
    return rows.length > 0;
  }

  async recordAuditEvent(input: {
    readonly event: string;
    readonly sub: string;
    readonly actor: string;
    readonly reason: string;
    readonly detail?: string;
  }): Promise<void> {
    await this.db.insert(adminApprovalEvents).values({
      id: newId("ade"),
      sub: input.sub,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      detail: input.detail ?? null,
    });
  }
}
