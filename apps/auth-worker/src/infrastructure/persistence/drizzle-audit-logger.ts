import { auditLogs, type IdentityDatabase } from "@u18/db";
import { newId } from "@u18/domain";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type {
  AuditEvent,
  AuditLogger,
  AuditLogReader,
  PersistedAuditLogEntry,
} from "../../application/ports/audit-log.port";

/**
 * 監査ログの書き込み失敗を表す、ログ上の目印。
 *
 * **これはアラートの照合キーである。** Cloudflare 側のアラートはこの文字列で
 * 引く（docs/runbook.md 3.3.4）。**変えるとアラートが黙って鳴らなくなる** ——
 * しかも鳴らないことは、鳴るべき事象が起きるまで誰も気づけない。
 * `test/audit-logger.test.ts` が値そのものを固定しているので、変えると落ちる。
 */
export const AUDIT_WRITE_FAILED = "audit_log.write_failed";

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
      //
      // ## 1 行の JSON で出す
      //
      // 以前は `console.error("audit log write failed", { ... })` だった。
      // 人間が読む分には問題ないが、**アラートの条件に書けない** ——
      // 可読文字列の部分一致に頼ることになり、文言を少し直しただけで
      // 鳴らなくなる。`rate_limit.exceeded` と同じ形（1 行の JSON、
      // 先頭に安定した `event`）に揃えて、機械が引ける形にする。
      //
      // ## 中身を載せない
      //
      // 出すのはイベント名と例外のメッセージだけ。`metadata` を流すと、
      // **失敗したときだけ秘密がログへ出る**という形になる
      // （`test/audit-logger.test.ts` が走査して確かめている）。
      // 例外も `message` だけを取り、スタックは載せない —— D1 の例外は
      // 失敗したクエリを含むことがあり、そこに値が乗りうる。
      console.error(
        JSON.stringify({
          event: AUDIT_WRITE_FAILED,
          /** 書けなかった監査イベントの名前。どの経路が落ちたかの手掛かり。 */
          auditEvent: event.event,
          reason: cause instanceof Error ? cause.name : "unknown",
        }),
      );
    }
  }
}

/**
 * 監査ログの閲覧（#375 / #382）。
 *
 * **`DrizzleAuditLogger` と同じファイルに置く。** 対象のテーブルが同じで、
 * 書き込みと読み取りを別クラスにする理由は Port の分離（interface
 * segregation）であって、ファイルを分ける理由ではない。
 */
export class DrizzleAuditLogReader implements AuditLogReader {
  constructor(private readonly db: IdentityDatabase) {}

  async listForAdmin(criteria: {
    readonly event?: string;
    readonly userId?: string;
    readonly outcome?: "success" | "failure";
    readonly after?: { readonly createdAt: Date; readonly id: string };
    readonly limit: number;
  }): Promise<readonly PersistedAuditLogEntry[]> {
    const conditions = [];

    if (criteria.event !== undefined) conditions.push(eq(auditLogs.event, criteria.event));
    if (criteria.userId !== undefined) conditions.push(eq(auditLogs.userId, criteria.userId));
    if (criteria.outcome !== undefined) conditions.push(eq(auditLogs.outcome, criteria.outcome));

    if (criteria.after !== undefined) {
      // **`id` を混ぜる。** 同じミリ秒に複数行が作られることは珍しくない
      // （1 回の操作が複数のイベントを書くことがある）。`created_at` だけでは
      // カーソルがそこで止まる。
      conditions.push(
        or(
          lt(auditLogs.createdAt, criteria.after.createdAt),
          and(
            eq(auditLogs.createdAt, criteria.after.createdAt),
            lt(auditLogs.id, criteria.after.id),
          ),
        ),
      );
    }

    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(criteria.limit)
      .all();

    return rows.map((row) => ({
      id: row.id,
      event: row.event,
      userId: row.userId,
      actor: row.actor,
      outcome: row.outcome,
      reason: row.reason,
      metadata: row.metadata,
      ipHash: row.ipHash,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
    }));
  }
}
