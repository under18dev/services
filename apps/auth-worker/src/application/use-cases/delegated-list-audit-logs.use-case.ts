import type { AuditLogReader, PersistedAuditLogEntry } from "../ports/audit-log.port";
import { decodeCursor, nextCursorOf } from "../../domain/services/keyset-cursor";
import { err, ok, type UseCaseResult } from "./types";

export type DelegatedListAuditLogsCommand = {
  readonly event?: string;
  readonly userId?: string;
  readonly outcome?: "success" | "failure";
  readonly cursor?: string;
  readonly limit?: number;
};

export type DelegatedListAuditLogsOutput = {
  readonly entries: readonly PersistedAuditLogEntry[];
  readonly nextCursor: string | null;
};

export type DelegatedListAuditLogsDeps = {
  readonly auditLogs: AuditLogReader;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * 監査ログの閲覧（admin-worker 経由、#390 決定 16 ③）。
 * `ListAuditLogsUseCase` と対になる。違いは認可を持たないことだけ ——
 * `DelegatedListUsersUseCase` の JSDoc を参照。
 */
export class DelegatedListAuditLogsUseCase {
  constructor(private readonly deps: DelegatedListAuditLogsDeps) {}

  async execute(
    command: DelegatedListAuditLogsCommand,
  ): Promise<UseCaseResult<DelegatedListAuditLogsOutput>> {
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
