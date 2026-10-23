import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt } from "./_shared";

/**
 * セキュリティイベントの監査ログ（仕様書 7.1 / 9）。
 *
 * ここにトークン・OTP・セッション値・生の IP を書かない。
 * 「誰が・何を・いつ」を後から追えることが目的で、再現に使える秘密は残さない。
 */
export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    /** 例: "session.created", "passkey.registered", "oauth.code.replayed" */
    event: text("event").notNull(),
    /** 操作対象のユーザー。未認証のイベントでは null。 */
    userId: text("user_id"),
    /** 操作に関わったクライアント（OAuth client / Worker 名）。 */
    actor: text("actor"),
    outcome: text("outcome", { enum: ["success", "failure"] }).notNull(),
    /** 失敗理由の短いコード。自由文のスタックトレースは入れない。 */
    reason: text("reason"),
    /** 追加文脈の JSON。秘密を含めないことを書き込み側で保証する。 */
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_logs_event_idx").on(table.event, table.createdAt),
    index("audit_logs_user_idx").on(table.userId, table.createdAt),
    index("audit_logs_created_idx").on(table.createdAt),
  ],
);
