import { hasFreshAuthentication } from "../../domain/services/reauthentication";
import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { PasskeyRepository } from "../ports/passkey.repository";
import type { GetSessionUseCase } from "./get-session.use-case";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type DeletePasskeyCommand = {
  readonly sessionToken: string;
  readonly passkeyId: string;
};

export type DeletePasskeyOutput = {
  readonly deleted: boolean;
  /** 削除後に残っている認証器の本数。UI が「残り 0 本」を案内するのに要る。 */
  readonly remaining: number;
};

export type DeletePasskeyDeps = {
  readonly getSession: GetSessionUseCase;
  readonly passkeys: PasskeyRepository;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * 登録済みの認証器を 1 本外す（仕様書 6.1 / 8.1、issue #75）。
 *
 * 守るものは 3 つ。所有者チェック、再認証、そして「外せること」そのもの。
 *
 * **最後の 1 本も消せる。** 仕様書 14.1-2 で「初回登録に Passkey を必須にしない」と
 * 決めており、メール OTP が常にログイン経路として残る。つまり全部外しても
 * 利用者が締め出されることはない。逆に最後の 1 本を残す設計にすると、
 * 盗まれた・譲渡した端末の Credential がそれ 1 本だけだった利用者が、
 * 危険な認証器を外せないまま固定される。これは issue #75 が塞ごうとしている
 * 穴そのものなので、残本数では拒否しない。
 */
export class DeletePasskeyUseCase {
  constructor(private readonly deps: DeletePasskeyDeps) {}

  async execute(command: DeletePasskeyCommand): Promise<UseCaseResult<DeletePasskeyOutput>> {
    const auth = await this.deps.getSession.execute({ sessionToken: command.sessionToken });
    if (!auth.ok) return auth;
    if (auth.value === null) return err("unauthenticated", "session is not valid");

    const { session, userId } = auth.value;

    // 再認証の判定を所有者チェックより前に置く。逆順にすると、古い
    // セッションを握った相手が応答の違い（not_found か再認証要求か）から
    // passkey ID の実在を確かめられる。
    //
    // 認証器の剥奪は乗っ取りの仕上げに使われる操作でもある。Cookie だけで
    // 通ると、セッション盗用がそのまま「正規の利用者からパスキーを奪う」に
    // なってしまう（issue #75）。
    if (!hasFreshAuthentication(session, this.deps.clock.now())) {
      await this.record(userId, "failure", { reason: "stale_authentication" });
      return err("reauthentication_required", "recent authentication is required");
    }

    const target = await this.deps.passkeys.findById(command.passkeyId);

    // 他人の Credential と存在しない Credential を同じ応答に畳む。
    // RevokeSessionUseCase と同じ理由で、区別して返すと ID の実在確認に使える。
    if (target === null || target.userId !== userId) {
      await this.record(userId, "failure", { reason: "not_found_or_not_owned" });
      return err("not_found", "passkey not found");
    }

    // userId を条件に含めた DELETE（Port 側）。所有者チェックは上で済んでいるが、
    // 破壊的な文の側にも同じ条件を残す。
    const deleted = await this.deps.passkeys.deleteOwned(target.id, userId);
    const remaining = (await this.deps.passkeys.listByUserId(userId)).length;

    await this.record(userId, deleted ? "success" : "failure", {
      ...(deleted ? {} : { reason: "already_deleted" }),
      // Credential ID と公開鍵は監査ログにも入れない。Credential ID は
      // 他サイトの記録と突き合わせれば同じ認証器だと分かる識別子で、
      // 本人を追跡する材料になる（仕様書 9 Privacy）。
      metadata: { passkeyId: target.id, deviceType: target.deviceType, remaining },
    });

    return ok({ deleted, remaining });
  }

  private async record(
    userId: string,
    outcome: "success" | "failure",
    extra: { reason?: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    await settleSideEffects(
      "passkey.deleted",
      this.deps.audit.record({ event: "passkey.deleted", userId, outcome, ...extra }),
    );
  }
}
