import type { AuditLogger } from "../ports/audit-log.port";
import type { UserRepository } from "../ports/user.repository";
import { requireExistingActor } from "./admin-access";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type DelegatedDeleteUserCommand = {
  readonly actorUserId: string;
  readonly userId: string;
};

export type DelegatedDeleteUserDeps = {
  readonly users: UserRepository;
  readonly audit: AuditLogger;
};

/**
 * 利用者の行を物理的に消す（admin-worker 経由、運用者判断 2026-11-08）。
 *
 * 仕様書 §14.1 決定 7（物理削除せず凍結で表現する）を運用者が上書きした
 * 判断に対応する。ドキュメント側の書き換えは別 PR（決定 7 本体・runbook
 * §11・脅威モデル）で行われ、ここでは触れない。
 *
 * ## `DelegatedManageUserUseCase` と対になる
 *
 * `suspend` / `reinstate` と同じく `requireExistingActor` だけで認可する
 * （admin-worker が管理者性を確かめ済み）。自分自身を対象にできない点も
 * 同じ——止める人が居なくなるのと同じ理由で、削除する人も居なくなる。
 *
 * **`DelegatedEnableOAuthClientUseCase` とは監査の持ち方が違う。** あちらは
 * 「何も起きなかった呼び出しも残す」が、ここでは呼ばない——未登録の
 * `userId` を叩く失敗を毎回記録すると、`suspend`/`reinstate` が
 * 失敗時に記録しない既存の方針と揃わなくなる（どちらも利用者を対象と
 * するイベントであり、揃える先はこちら）。削除が実際に起きたときだけ
 * `ops.user.deleted` を書く。
 *
 * ## NFC カードと `admin_approvals` は触らない
 *
 * `nfc_cards.owner_user_id` と `admin_approvals.sub` は別の D1 にあり、
 * FK を張れない（各スキーマの注釈を参照）。運用者の明示的な選択で、
 * **存在しない userId を指す行がそれぞれに残り続ける。** 消し忘れでは
 * ない——次に読んだ人がここを「直し忘れ」と誤解しないよう明記しておく。
 */
export class DelegatedDeleteUserUseCase {
  constructor(private readonly deps: DelegatedDeleteUserDeps) {}

  async execute(
    command: DelegatedDeleteUserCommand,
  ): Promise<UseCaseResult<Record<string, never>>> {
    const actor = await requireExistingActor(this.deps, command.actorUserId);
    if (!actor.ok) return actor;

    // 自分自身は消せない。止められなくなる人が居なくなるのと同じ理由
    // （`DelegatedManageUserUseCase.authorize`）。
    if (command.actorUserId === command.userId) {
      return err("conflict", "cannot delete yourself");
    }

    const deleted = await this.deps.users.deletePermanently(command.userId);
    if (!deleted) return err("not_found", "user does not exist");

    await settleSideEffects(
      "ops.user.deleted",
      this.deps.audit.record({
        event: "ops.user.deleted",
        userId: command.userId,
        outcome: "success",
        metadata: { actorUserId: command.actorUserId },
      }),
    );

    return ok({});
  }
}
