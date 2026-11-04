import { adminApprovals, type AdminDatabase } from "@u18/admin-db";
import { eq, sql } from "drizzle-orm";
import type { ApprovalRepository } from "../../application/ports/approval.repository";
import { effectivePermissions, parsePermissions, type EffectivePermissions } from "../../domain/permissions";

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
}
