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
 *
 * ## `active` は対象にしない（運用者の判断、2026-11-08）
 *
 * 削除できるのは `suspended` / `deleted` の行だけ。**凍結を経由せずに
 * `active` のアカウントをいきなり消せない。** 運用は「`suspend` →
 * `deleteUser`」の 2 段階になる。
 *
 * **判定は `Repository.deletePermanently` 自身が持つ**（1 文の中で
 * `status <> 'active'` を条件にする）。ここで先に `findById` して
 * status を見てから呼ぶ形にしなかったのは、読んでから書くまでの間に
 * 状態が変わる余地を作らないため（`setStatus` と同じ判断）。
 *
 * 失敗したときだけ `findById` で引き直し、`not_found`（そもそも居ない）
 * と `conflict`（`active` なので先に凍結が要る）を区別する——
 * `updateProfile` が `username_taken` と `not_found` を同じ形で
 * 区別しているのと同じ考え方。
 *
 * ## 順序: 自分自身 → `active` かどうか
 *
 * **自分自身のチェックを先にする。** `admin-access.ts` の
 * 「『管理者か』が先、『新しいか』が後——逆だと一般利用者に
 * `reauthentication_required` が返り、管理機能の存在が伝わる」という
 * 先例と同じ観点で順序を選んだが、ここでは**情報の非対称が無い**。
 * `actorUserId === userId` が成り立つのは呼び出し元が自分自身を
 * 対象にしたときだけで、そのときの `status` は呼び出した本人が
 * 既に知っている値である——順序をどちらにしても、第三者には何も
 * 伝わらない。先例を機械的に当てはめるのではなく、**漏れる情報が
 * 無いことを確かめたうえで**、`DelegatedManageUserUseCase.authorize`
 * と同じ並び（自分自身 → 状態）に揃えた。
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
    if (!deleted) {
      // 失敗した理由を区別するためだけに引き直す（判定そのものは
      // `deletePermanently` の 1 文が既に原子的に下している）。
      const target = await this.deps.users.findById(command.userId);
      if (target === null) return err("not_found", "user does not exist");
      return err("conflict", "suspend the user before deleting (status is active)");
    }

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
