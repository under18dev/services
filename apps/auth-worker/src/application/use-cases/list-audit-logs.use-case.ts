import type { AuditLogReader, PersistedAuditLogEntry } from "../ports/audit-log.port";
import { decodeCursor, nextCursorOf } from "../../domain/services/keyset-cursor";
import { requireAdminSession, type AdminAccessDeps } from "./admin-access";
import { err, ok, type UseCaseResult } from "./types";

export type ListAuditLogsCommand = {
  readonly sessionToken: string;
  readonly event?: string;
  readonly userId?: string;
  readonly outcome?: "success" | "failure";
  readonly cursor?: string;
  readonly limit?: number;
};

export type ListAuditLogsOutput = {
  readonly entries: readonly PersistedAuditLogEntry[];
  readonly nextCursor: string | null;
};

export type ListAuditLogsDeps = AdminAccessDeps & {
  readonly auditLogs: AuditLogReader;
};

const DEFAULT_LIMIT = 50;
/** 1 回の上限。**「監査ログを 1 リクエストで吸い出す口」にしないため。** */
const MAX_LIMIT = 200;

/**
 * 監査ログの閲覧（#375 / #382）。**管理者のみ。**
 *
 * `ListUsersUseCase` と対になる。**壁 → 入力の検査、の順序も同じ**
 * （逆にすると `invalid_input` と `not_found` の出し分けから管理者かどうかが
 * 読める）。
 *
 * ## これは「監査ログを読む」という操作自体を監査しない
 *
 * `ListOAuthClientsUseCase` / `ListUsersUseCase` と同じ判断。読み取りで
 * 状態が変わらないうえ、**拒否のたびに書くと有効なセッションを持つ相手が
 * `audit_logs` を伸ばせる**（RPC 経路にレート制限が無い）。この UseCase は
 * `AuditLogger` を依存に持たない。
 *
 * ## `metadata` をそのまま返す
 *
 * 追加の選別はしない。`metadata` に秘密を入れないことは書き込み側
 * （`AuditEvent` の JSDoc）と `test/audit-secrets.test.ts` が保証している
 * ので、読み取り側で二重に選別すると「何が安全に含まれるか」の正本が
 * 2 か所になる。
 */
export class ListAuditLogsUseCase {
  constructor(private readonly deps: ListAuditLogsDeps) {}

  async execute(command: ListAuditLogsCommand): Promise<UseCaseResult<ListAuditLogsOutput>> {
    const admin = await requireAdminSession(this.deps, command.sessionToken, "listAuditLogs");
    if (!admin.ok) return admin;

    const limit = Math.min(command.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const after = command.cursor === undefined ? undefined : decodeCursor(command.cursor);
    if (command.cursor !== undefined && after === null) {
      return err("invalid_input", "cursor is malformed");
    }

    const rows = await this.deps.auditLogs.listForAdmin({
      ...(command.event === undefined ? {} : { event: command.event }),
      ...(command.userId === undefined ? {} : { userId: command.userId }),
      ...(command.outcome === undefined ? {} : { outcome: command.outcome }),
      ...(after === undefined || after === null ? {} : { after }),
      limit: limit + 1,
    });

    return ok({
      entries: rows.slice(0, limit),
      nextCursor: nextCursorOf(rows, limit),
    });
  }
}
