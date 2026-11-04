import type { User } from "../../domain/entities/user";
import type { UserRepository } from "../ports/user.repository";
import { err, ok, type UseCaseResult } from "./types";

export type DelegatedGetUserCommand = {
  readonly userId: string;
};

export type DelegatedGetUserDeps = {
  readonly users: UserRepository;
};

/**
 * 利用者 1 人を引く（admin-worker 経由、#455）。
 *
 * **`DelegatedListUsersUseCase` の「1 件版」ではない。** あちらは
 * `listForAdmin`（並び替えとカーソル）を通るが、こちらは `findById` ——
 * 主キー 1 本である。一覧を引いてから絞る形にしないのは、**画面に出すのが
 * 常に 1 行なのに、取得の重さだけが利用者数に比例する**ため
 * （`GetUserDelegatedInput` の冒頭、#449 と同じ判断）。
 *
 * **認可を持たない。** `DelegatedListUsersUseCase` と同じで、確かめるのは
 * admin-worker 側である（`IdentityAdminDelegatedRpcContract` の冒頭）。
 *
 * **`actorUserId` を受け取らない。** 読み取りは監査ログに 1 行も書かない
 * ので、「誰が呼んだか」を使う場所が無い（`DelegatedListUsersUseCase` と
 * 同じ非対称）。
 *
 * **退会した人・`deleted` の人も返す。** 返さないと、詳細ページが
 * 「存在しない」と「状態がそれ以上に進んでいる」を区別できなくなる ——
 * 運用者がいちばん確かめたいのは、まさにその状態の人である。
 */
export class DelegatedGetUserUseCase {
  constructor(private readonly deps: DelegatedGetUserDeps) {}

  async execute(command: DelegatedGetUserCommand): Promise<UseCaseResult<User>> {
    const user = await this.deps.users.findById(command.userId);
    if (user === null) return err("not_found", "no such user");

    return ok(user);
  }
}
