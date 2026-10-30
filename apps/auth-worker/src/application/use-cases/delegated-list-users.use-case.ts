import type { User } from "../../domain/entities/user";
import { decodeCursor, nextCursorOf } from "../../domain/services/keyset-cursor";
import type { UserRepository } from "../ports/user.repository";
import { err, ok, type UseCaseResult } from "./types";

export type DelegatedListUsersCommand = {
  readonly query?: string;
  readonly cursor?: string;
  readonly limit?: number;
};

export type DelegatedListUsersOutput = {
  readonly users: readonly User[];
  readonly nextCursor: string | null;
};

export type DelegatedListUsersDeps = {
  readonly users: UserRepository;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * 利用者の一覧（admin-worker 経由、#390 決定 16 ③）。
 *
 * `ListUsersUseCase` と対になる。**違いは認可を持たないことだけ** ——
 * admin-worker が呼ぶ前に自分の承認リストで確かめている
 * （`IdentityAdminDelegatedRpcContract` の冒頭）。`IdentityGateway` 相当の
 * 依存を 1 つも持たない。
 *
 * **`actorUserId` を受け取らない。** 読み取りは監査ログに 1 行も書かない
 * （`ListUsersUseCase` と同じ判断 —— 拒否のたびに書くと D1 への書き込みに
 * 変換される）ので、「誰が呼んだか」を使う場所が無い。書く操作
 * （`DelegatedManageUserUseCase` など）とはここが違う。
 */
export class DelegatedListUsersUseCase {
  constructor(private readonly deps: DelegatedListUsersDeps) {}

  async execute(
    command: DelegatedListUsersCommand,
  ): Promise<UseCaseResult<DelegatedListUsersOutput>> {
    const limit = Math.min(command.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const after = command.cursor === undefined ? undefined : decodeCursor(command.cursor);
    if (command.cursor !== undefined && after === null) {
      return err("invalid_input", "cursor is malformed");
    }

    const rows = await this.deps.users.listForAdmin({
      ...(command.query === undefined ? {} : { query: command.query }),
      ...(after === undefined || after === null ? {} : { after }),
      limit: limit + 1,
    });

    return ok({
      users: rows.slice(0, limit),
      nextCursor: nextCursorOf(rows, limit),
    });
  }
}
