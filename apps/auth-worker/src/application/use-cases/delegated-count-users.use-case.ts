import type { UserRepository } from "../ports/user.repository";
import { ok, type UseCaseResult } from "./types";

export type DelegatedCountUsersDeps = {
  readonly users: UserRepository;
};

export type DelegatedCountUsersResult = {
  readonly active: number;
  readonly suspended: number;
  readonly deleted: number;
};

/**
 * 状態ごとの利用者数（admin-worker のホーム用、#512）。
 * `DelegatedCountOAuthClientsUseCase` と対だが、**`listForAdmin` は
 * 呼ばない** —— `UserRepository.countByStatus()` の冒頭を参照。
 */
export class DelegatedCountUsersUseCase {
  constructor(private readonly deps: DelegatedCountUsersDeps) {}

  async execute(): Promise<UseCaseResult<DelegatedCountUsersResult>> {
    return ok(await this.deps.users.countByStatus());
  }
}
