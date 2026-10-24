import type { AuditLogger } from "../ports/audit-log.port";
import type { AuthorizationCodeRepository } from "../ports/authorization-code.repository";
import type { Clock } from "../ports/clock.port";
import type { OAuthClientRepository } from "../ports/oauth-client.repository";
import type { OAuthGrantRepository } from "../ports/oauth-grant.repository";
import type { OAuthTokenRepository } from "../ports/oauth-token.repository";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";
import type { GetSessionUseCase } from "./get-session.use-case";

export type RevokeGrantCommand = {
  readonly sessionToken: string;
  /** 公開 `client_id`。内部 ID は受け付けない。 */
  readonly clientId: string;
};

export type RevokeGrantOutput = {
  readonly revoked: boolean;
  readonly revokedTokenCount: number;
};

export type RevokeGrantDeps = {
  readonly getSession: GetSessionUseCase;
  readonly clients: OAuthClientRepository;
  readonly grants: OAuthGrantRepository;
  readonly tokens: OAuthTokenRepository;
  /** 未交換の認可コードも道連れにするため（#18）。 */
  readonly codes: AuthorizationCodeRepository;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * 同意を取り消す（#18）。
 *
 * ## 取り消しは 3 つのテーブルに及ぶ
 *
 * `oauth_grants` に `revoked_at` を立てるだけでは、利用者の期待を満たさない。
 * 「許可を取り消した」のに、発行済みの Access Token が最大 10 分間
 * `/oauth/userinfo` から claim を返し続け、未交換の認可コードが 60 秒間
 * 新しいトークンへ化けうる。利用者が押したボタンの意味は
 * 「このアプリから私の情報へのアクセスを今すぐ止める」であって、
 * 「次回から同意画面を出す」ではない。
 *
 * したがって順に 3 つを行う。
 *
 * 1. `oauth_grants.revoked_at` —— 以後の認可要求で同意画面に戻す
 * 2. `oauth_tokens` を grant 単位で失効（`revokeByGrant`）
 * 3. そのユーザーの未交換コードを失効
 *
 * **トークンの失効は、同意の取り消しが「false（既に取り消し済み）」でも行う。**
 * 片方だけ成功した中断や、別経路で `oauth_grants` だけが落ちた状態から
 * 呼び直したときに、残ったトークンを掃除できるようにしておく。再実行で
 * 状態が必ず収束するほうが、運用で救える幅が広い。
 *
 * 3 が広すぎる（そのクライアント宛てとは限らない）のは承知の上である。
 * `oauth_authorization_codes` に `grant_id` は無く、絞るには
 * `(user_id, client_id)` で引く Port を足すことになる。安全側に広く倒し、
 * 巻き添えになる利用者は同じ人自身で、やり直せば回復する——
 * `ExchangeAuthorizationCodeUseCase` のリプレイ処理と同じ判断である。
 *
 * ## 「無い同意」と「他人の同意」を区別しない
 *
 * `clientId` は呼び出し元が自由に指定できる。未知のクライアントも、
 * 同意していないクライアントも、同じ `not_found` に畳む。区別すると、
 * ダッシュボードが「どの client_id が登録済みか」を総当たりで調べる
 * 窓口になる。`RevokeSessionUseCase` が他人のセッションと存在しない
 * セッションを同一視しているのと同じ理由。
 */
export class RevokeGrantUseCase {
  constructor(private readonly deps: RevokeGrantDeps) {}

  async execute(command: RevokeGrantCommand): Promise<UseCaseResult<RevokeGrantOutput>> {
    const auth = await this.deps.getSession.execute({ sessionToken: command.sessionToken });
    if (!auth.ok) return auth;
    if (auth.value === null) return err("unauthenticated", "session is not valid");

    const { userId } = auth.value;

    // 失効済みクライアントでも取り消せること。`findByClientId` は
    // `disabled_at` が立った行も返すので、運営がクライアントを止めた後でも
    // 利用者は自分の同意を片付けられる。
    const client = await this.deps.clients.findByClientId(command.clientId);
    const grant = client === null ? null : await this.deps.grants.find(userId, client.id);

    if (client === null || grant === null) {
      await this.record(userId, "failure", "not_found_or_not_owned", command.clientId);
      return err("not_found", "grant not found");
    }

    const now = this.deps.clock.now();
    const revoked = await this.deps.grants.revoke(userId, client.id, now);
    const revokedTokenCount = await this.deps.tokens.revokeByGrant(grant.id, now);
    await this.deps.codes.revokeUnconsumedByUser(userId, now);

    await this.record(userId, "success", revoked ? "revoked" : "already_revoked", client.clientId, {
      revokedTokenCount,
    });

    return ok({ revoked, revokedTokenCount });
  }

  private async record(
    userId: string,
    outcome: "success" | "failure",
    reason: string,
    clientId: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await settleSideEffects(
      "oauth.grant.revoked",
      this.deps.audit.record({
        event: "oauth.grant.revoked",
        userId,
        outcome,
        reason,
        metadata: { clientId, ...extra },
      }),
    );
  }
}
