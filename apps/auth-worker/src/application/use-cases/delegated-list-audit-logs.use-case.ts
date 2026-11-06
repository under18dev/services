import type { AuditLogReader, PersistedAuditLogEntry } from "../ports/audit-log.port";
import { decodeCursor, nextCursorOf } from "../../domain/services/keyset-cursor";
import { err, ok, type UseCaseResult } from "./types";

export type DelegatedListAuditLogsCommand = {
  readonly event?: string;
  /**
   * 区分での絞り込み（#515）の実体——`IN` 相当の集合一致。**`category`
   * という語はここには無い。** `"operator_action"` がどのイベント名の
   * 集合を指すかは契約の DTO と entrypoint の層で解決済みで、ここには
   * 素の名前の集合だけが渡る——application 層は `@u18/contracts` を
   * import しない（`identity-admin-delegated.entrypoint.ts` の該当箇所を
   * 参照）。
   */
  readonly events?: readonly string[];
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
      ...(command.events === undefined ? {} : { events: command.events }),
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
