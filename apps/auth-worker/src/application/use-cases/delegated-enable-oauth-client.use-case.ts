import type { AuditLogger } from "../ports/audit-log.port";
import type { OAuthClientRepository } from "../ports/oauth-client.repository";
import type { UserRepository } from "../ports/user.repository";
import { requireExistingActor } from "./admin-access";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type DelegatedEnableOAuthClientCommand = {
  readonly actorUserId: string;
  readonly clientId: string;
};

export type DelegatedEnableOAuthClientOutput = {
  readonly enabled: boolean;
};

export type DelegatedEnableOAuthClientDeps = {
  readonly users: UserRepository;
  readonly clients: OAuthClientRepository;
  readonly audit: AuditLogger;
};

/**
 * OAuth クライアントの失効を解除する（admin-worker 経由、#551）。
 * `DelegatedDisableOAuthClientUseCase` の裏返し。
 *
 * ## 2 段階確認は無い
 *
 * `disable` と違い、押した瞬間に戻せなくなる操作ではない——有効化しても
 * 発行済みの Access Token が増えるわけではなく、やり直しが利く
 * （もう一度失効させればよい）。確認は要らない。
 *
 * ## 一次パーティは有効化できない（`disable` と対称）
 *
 * 作れない・止められないものを、この入口から戻せる理由も無い。
 * `u18-dashboard` は CLI で止めたなら CLI の `enable` で戻す——
 * 管理者 1 人の判断で u18 全サービスのログインを戻せる形にしない。
 *
 * 一次パーティはそもそもこの入口から失効させられないので、ここに来る
 * のは「CLI で止めた一次パーティを、画面からうっかり戻そうとした」
 * ケースのみ。`disable` と同じ理由で拒否する。
 *
 * ## 「未登録」と「失効していない」を区別しない
 *
 * `disable` が「未登録」と「失効済み」を区別しないのと対称——どちらも
 * `enabled: false` を返す。総当たりで `client_id` の実在を調べさせない。
 *
 * ## 冪等
 *
 * `disabled_at IS NOT NULL` を条件にした UPDATE 1 文で行う
 * （Repository 側）。既に有効なものへの再実行は 0 行更新で `false` を
 * 返すが、**その呼び出し自体は監査ログに残る**（`disable` が
 * `already_disabled_or_unknown` を残すのと対称、`record` を参照）。
 */
export class DelegatedEnableOAuthClientUseCase {
  constructor(private readonly deps: DelegatedEnableOAuthClientDeps) {}

  async execute(
    command: DelegatedEnableOAuthClientCommand,
  ): Promise<UseCaseResult<DelegatedEnableOAuthClientOutput>> {
    const actor = await requireExistingActor(this.deps, command.actorUserId);
    if (!actor.ok) return actor;
    const actorUserId = actor.value.userId;

    // **一次パーティは有効化させない。** `disable` と対称——この入口から
    // 作れない・止められないものを、この入口から戻せてよい理由が無い。
    const target = await this.deps.clients.findByClientId(command.clientId);
    if (target !== null && target.isFirstParty) {
      await this.record(actorUserId, "failure", command.clientId, "first_party");
      return err(
        "conflict",
        "first-party clients can only be enabled with scripts/oauth-client.mjs",
      );
    }

    const enabled = await this.deps.clients.enable(command.clientId);

    // 何も起きなかった呼び出しも残す（`disable` と対称）。既に有効な
    // ものへの再実行と、存在しない client_id の指定は、応答では
    // 区別しないが記録では分かる。
    await this.record(
      actorUserId,
      enabled ? "success" : "failure",
      command.clientId,
      enabled ? undefined : "already_enabled_or_unknown",
    );

    return ok({ enabled });
  }

  private async record(
    actorUserId: string,
    outcome: "success" | "failure",
    clientId: string,
    reason?: string,
  ): Promise<void> {
    await settleSideEffects(
      "oauth.client.enabled",
      this.deps.audit.record({
        event: "oauth.client.enabled",
        userId: actorUserId,
        outcome,
        ...(reason === undefined ? {} : { reason }),
        metadata: { clientId },
      }),
    );
  }
}
