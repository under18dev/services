import { hasFreshAuthentication } from "../../domain/services/reauthentication";
import type { AuditEventName, AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { SessionRepository } from "../ports/session.repository";
import type { UserRepository } from "../ports/user.repository";
import { requireAdminSession, type AdminAccessDeps } from "./admin-access";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

/**
 * 停止した理由。**`status` は 1 値しか持てないので、ここが唯一の記録になる。**
 *
 * ランブック §11.1 の表が区別している 3 つのうち、管理者が立てるのは
 * 上の 2 つ（3 つ目の「本人の退会」は `account.closed` が記録する）。
 *
 * **自由記述にしていない。** 後から集計も検索もできない文字列より、
 * 「戻す前提か」が読める 2 値のほうが運用に効く —— §11.6 の purge の
 * 対象になるのは `deleted` だけなので、**停止の理由は「戻してよいか」を
 * 判断するためだけに要る。**
 */
export type SuspendReason = "compromise" | "abuse";

export type SuspendUserCommand = {
  readonly sessionToken: string;
  readonly userId: string;
  readonly reason: SuspendReason;
};

export type ReinstateUserCommand = {
  readonly sessionToken: string;
  readonly userId: string;
};

export type RevokeUserSessionsCommand = {
  readonly sessionToken: string;
  readonly userId: string;
};

export type ManageUserDeps = AdminAccessDeps & {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * 管理者による利用者の停止・解除・セッション失効（#375 / #382）。
 *
 * ## `audit_logs` に書く —— `listUsers` と判断が違う
 *
 * あちらは読み取りで、**拒否のたびに書くと攻撃者が D1 への書き込みを
 * 誘発できた。** こちらは状態を変える操作で、**通るのは管理者だけ**
 * なので件数が管理者の数で頭打ちになる。`ops.admin.*` と同じ扱い。
 *
 * **拒否（管理者でない呼び出し）は書かない。** それは
 * `requireAdminSession` の中で `admin.denied` として observability へ
 * 出る。ここに着く時点で相手は管理者である。
 *
 * ## 再認証を要求する
 *
 * **他人のアカウントを止める操作である。** 置き忘れた端末の Cookie
 * 1 枚で通ってよいものではない（`CloseAccountUseCase` と同じ窓、
 * `deletePasskey` / `createOAuthClient` と揃えて 5 分）。
 *
 * ## 自分は止められない
 *
 * 止めた瞬間に自分のセッションが死に、**解除する人が居なくなる。**
 * 管理者が 1 人の環境では復旧手段が `wrangler` だけになる。
 * `conflict` で弾く。
 *
 * ## 停止はセッションを切るまでが 1 組
 *
 * **切らなくても次の要求から通らない**（`GetSessionUseCase` が
 * `isActive` を見る）。それでも切るのは、**止まっているのに生きた行が
 * 残る**状態を作らないため —— `CloseAccountUseCase` が本人の退会で
 * 切っているのと揃える。**画面は「切ったから止まる」と書かないこと。**
 */
export class ManageUserUseCase {
  constructor(private readonly deps: ManageUserDeps) {}

  async suspend(command: SuspendUserCommand): Promise<UseCaseResult<{ revokedSessions: number }>> {
    const guard = await this.authorize(command.sessionToken, command.userId, "suspendUser");
    if (!guard.ok) return guard;

    const changed = await this.deps.users.setStatus(command.userId, {
      from: "active",
      to: "suspended",
    });
    if (!changed) {
      // 既に `active` ではない。退会済み・停止済み・`deleted`・そもそも
      // 居ない —— **どれも区別しない。** 区別すると、存在するかどうかを
      // 当てる窓口になる（`revokeGrant` と同じ判断）。
      return err("conflict", "user is not active");
    }

    const revokedSessions = await this.deps.sessions.revokeAllForUser(
      command.userId,
      this.deps.clock.now(),
    );

    await this.record({
      event: "ops.user.suspended",
      userId: command.userId,
      outcome: "success",
      metadata: {
        // **理由はここにしか無い。** `status` は `suspended` の 1 値。
        reason: command.reason,
        revokedSessions,
        actorUserId: guard.value.actorId,
      },
    });

    return ok({ revokedSessions });
  }

  async reinstate(command: ReinstateUserCommand): Promise<UseCaseResult<Record<string, never>>> {
    const guard = await this.authorize(command.sessionToken, command.userId, "reinstateUser");
    if (!guard.ok) return guard;

    const changed = await this.deps.users.setStatus(command.userId, {
      from: "suspended",
      to: "active",
    });
    if (!changed) {
      // **`deleted` はここに来ない**（`setStatus` の型が受け取らない）。
      // 個人情報を落とした行を `active` に戻せる経路は作らない。
      return err("conflict", "user is not suspended");
    }

    await this.record({
      event: "ops.user.reinstated",
      userId: command.userId,
      outcome: "success",
      metadata: { actorUserId: guard.value.actorId },
    });

    return ok({});
  }

  async revokeSessions(
    command: RevokeUserSessionsCommand,
  ): Promise<UseCaseResult<{ revokedSessions: number }>> {
    const guard = await this.authorize(command.sessionToken, command.userId, "revokeUserSessions", {
      allowSelf: true,
    });
    if (!guard.ok) return guard;

    const revokedSessions = await this.deps.sessions.revokeAllForUser(
      command.userId,
      this.deps.clock.now(),
    );

    await this.record({
      event: "ops.user.sessions_revoked",
      userId: command.userId,
      outcome: "success",
      metadata: { revokedSessions, actorUserId: guard.value.actorId },
    });

    return ok({ revokedSessions });
  }

  /**
   * 3 つに共通する関門。**管理者 → 新しい認証 → 自分でない、の順。**
   *
   * 順序に意味がある。管理者でない相手には**何を聞いても `not_found`**
   * でなければならない —— 先に再認証を見ると、`reauthentication_required`
   * が返る相手と返らない相手の違いから**管理機能の存在が漏れる。**
   * （#331 のレビューで `admin-access.ts` に書いた順序と同じ。）
   */
  private async authorize(
    sessionToken: string,
    targetUserId: string,
    operation: "suspendUser" | "reinstateUser" | "revokeUserSessions",
    options: { readonly allowSelf?: boolean } = {},
  ): Promise<UseCaseResult<{ actorId: string }>> {
    const admin = await requireAdminSession(this.deps, sessionToken, operation);
    if (!admin.ok) return admin;

    if (!hasFreshAuthentication(admin.value.session, this.deps.clock.now())) {
      return err("reauthentication_required", "recent authentication is required");
    }

    if (options.allowSelf !== true && admin.value.userId === targetUserId) {
      // **自分を止めると解除する人が居なくなる。** セッションの失効だけは
      // 自分に対して意味がある（全端末からログアウト）ので許す。
      return err("conflict", "cannot apply this operation to yourself");
    }

    return ok({ actorId: admin.value.userId });
  }

  /**
   * 監査ログへ 1 行。
   *
   * ## イベント名を呼ぶ側がリテラルで書く
   *
   * **ここで組み立てると、`vitest.config.ts` の走査から消える。**
   * あれは `src` から `event: "..."` の形を集めて `AUDIT_EVENTS` と
   * 突き合わせており（#22）、名前を引数で渡すと「登録簿にあるが
   * どこからも発行されていない」と報告される —— **実際に報告された。**
   *
   * 繰り返しは増えるが、**どのメソッドがどのイベントを出すかが、
   * 出す場所に書いてある**ほうが読める。
   *
   * **`userId` は操作された側である。** `actor` は `AuditLogger` が
   * `RequestContext` から入れる（#149）ので渡さない —— 渡せるように
   * すると、呼ぶ側が別の値を入れられる。
   *
   * **誰がやったかは `metadata.actorUserId` に入れる。** `actor` は
   * 「どの Worker から来たか」で、**管理者が複数になったときに人を
   * 特定できない。**
   */
  private async record(entry: {
    readonly event: AuditEventName;
    readonly userId: string;
    readonly outcome: "success" | "failure";
    readonly metadata: Record<string, unknown>;
  }): Promise<void> {
    await settleSideEffects(entry.event, this.deps.audit.record(entry));
  }
}
