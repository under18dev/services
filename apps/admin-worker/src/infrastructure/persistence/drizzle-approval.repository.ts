import { adminApprovals, type AdminDatabase } from "@u18/admin-db";
import { eq } from "drizzle-orm";
import type { ApprovalRepository } from "../../application/ports/approval.repository";

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
}
