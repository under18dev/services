import { auditLogs, type IdentityDatabase } from "@u18/db";
import { newId } from "@u18/domain";
import type { AuditEvent, AuditLogger } from "../../application/ports/audit-log.port";

export class DrizzleAuditLogger implements AuditLogger {
  constructor(private readonly db: IdentityDatabase) {}

  async record(event: AuditEvent): Promise<void> {
    try {
      await this.db
        .insert(auditLogs)
        .values({
          id: newId("aud"),
          event: event.event,
          userId: event.userId ?? null,
          actor: event.actor ?? null,
          outcome: event.outcome,
          reason: event.reason ?? null,
          metadata: event.metadata ?? null,
          ipHash: event.ipHash ?? null,
          userAgent: event.userAgent ?? null,
        })
        .run();
    } catch (cause) {
      // 監査ログが書けないことを理由に認証自体を失敗させない。
      // 書き込み失敗は Workers のログに残し、可観測性側で検知する。
      console.error("audit log write failed", { event: event.event, cause });
    }
  }
}
