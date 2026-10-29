import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { OAuthClientRepository } from "../ports/oauth-client.repository";
import { requireAdminSession, type AdminAccessDeps } from "./admin-access";
import { settleSideEffects } from "./side-effects";
import { ok, type UseCaseResult } from "./types";

export type DisableOAuthClientCommand = {
  readonly sessionToken: string;
  /** 公開 `client_id`。内部 ID は受け付けない。 */
  readonly clientId: string;
};

export type DisableOAuthClientOutput = {
  /** 行が「失効済み」へ遷移したか。既に失効済み・未登録なら false。 */
  readonly disabled: boolean;
};

export type DisableOAuthClientDeps = AdminAccessDeps & {
  readonly clients: OAuthClientRepository;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * OAuth クライアントを失効させる（#308）。**管理者のみ。**
 *
 * ## 冪等
 *
 * `disabled_at IS NULL` を条件にした UPDATE 1 文で行う（Repository 側）。
 * 2 度目は 0 行更新で `false` を返し、**最初の失効時刻は動かない** ——
 * 上書きされると「いつ止めたか」を根拠にした事後調査が狂う
 * （脅威モデル E-4 と同じ形）。
 *
 * ## 「未登録」と「失効済み」を区別しない
 *
 * どちらも `disabled: false` を返す。区別すると、どの `client_id` が
 * 登録済みかを総当たりで調べる窓口になる（`RevokeGrantUseCase` と同じ
 * 判断）。管理者しか通らない経路ではあるが、**応答の形を理由に
 * 「管理者だから良い」と緩めると、その緩さは入口が増えたときに残る。**
 *
 * ## 失効は即座に効く
 *
 * `findByClientId` は失効済みの行も返すが、`OAuthClient.isDisabled` を見る
 * UseCase 側が拒否する（#13 受け入れ条件）。発行済みのトークンまでは
 * 止めない —— そこは同意の取り消し（`RevokeGrantUseCase`）の仕事で、
 * クライアントの失効は「以後の認可を止める」操作である。
 */
export class DisableOAuthClientUseCase {
  constructor(private readonly deps: DisableOAuthClientDeps) {}

  async execute(
    command: DisableOAuthClientCommand,
  ): Promise<UseCaseResult<DisableOAuthClientOutput>> {
    const admin = await requireAdminSession(
      this.deps,
      command.sessionToken,
      "oauth.client.disabled",
    );
    if (!admin.ok) return admin;

    const disabled = await this.deps.clients.disable(command.clientId, this.deps.clock.now());

    // 何も起きなかった呼び出しも残す。失効済みに対する再実行と、
    // 存在しない client_id の指定は、応答では区別しないが記録では分かる
    // （`reason` を見れば「2 度目だった」ことが追える）。
    await settleSideEffects(
      "oauth.client.disabled",
      this.deps.audit.record({
        event: "oauth.client.disabled",
        userId: admin.value.userId,
        outcome: disabled ? "success" : "failure",
        ...(disabled ? {} : { reason: "already_disabled_or_unknown" }),
        metadata: { clientId: command.clientId },
      }),
    );

    return ok({ disabled });
  }
}
