import type { User } from "../../domain/entities/user";
import type { UserRepository } from "../ports/user.repository";
import { ok, type UseCaseResult } from "./types";

export type DelegatedGetUsersByIdsCommand = {
  readonly userIds: readonly string[];
};

export type DelegatedGetUsersByIdsDeps = {
  readonly users: UserRepository;
};

/**
 * 利用者をまとめて引く（admin-worker の一覧が所有者・actor を名前で
 * 出すため、#471）。
 *
 * **`DelegatedGetUserUseCase` の複数件版ではない。** あちらは `not_found`
 * を返しうるが、こちらは**失敗しない**——見つからなかった ID は結果から
 * 黙って落ちる（`GetUsersByIdsDelegatedResult` の冒頭）。一覧の名前解決は
 * 「引けただけ出す」ものであって、1 件の欠落が全体を失敗させてはいけない。
 *
 * **認可を持たない。** `DelegatedGetUserUseCase` と同じで、確かめるのは
 * admin-worker 側である。
 */
export class DelegatedGetUsersByIdsUseCase {
  constructor(private readonly deps: DelegatedGetUsersByIdsDeps) {}

  async execute(command: DelegatedGetUsersByIdsCommand): Promise<UseCaseResult<readonly User[]>> {
    if (command.userIds.length === 0) return ok([]);

    const users = await this.deps.users.findByIds(command.userIds);
    return ok(users);
  }
}
