import type { AuditLogger } from "../ports/audit-log.port";
import type { AuthorizationCodeRepository } from "../ports/authorization-code.repository";
import type { Clock } from "../ports/clock.port";
import type { TokenHasher } from "../ports/crypto.port";
import type { SessionRepository } from "../ports/session.repository";
import { settleSideEffects } from "./side-effects";
import { ok, type UseCaseResult } from "./types";

export type LogoutCommand = {
  readonly sessionToken: string;
  /** true なら同じユーザーの全セッションを失効させる（別デバイス含む）。 */
  readonly allDevices: boolean;
};

export type LogoutOutput = {
  /** 失効させたセッション数。0 でも成功扱い。 */
  readonly revokedCount: number;
};

export type LogoutDeps = {
  readonly sessions: SessionRepository;
  /** ログアウトで未交換の認可コードを連鎖失効させるため（#15）。 */
  readonly codes: AuthorizationCodeRepository;
  readonly hasher: TokenHasher;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * ログアウト。
 *
 * **無効なトークンでも成功を返す**（冪等）。
 * 「そのセッションは存在しなかった」と教えると、トークンの実在を確かめる
 * 手段になる。利用者から見ればどちらもログアウト済みで違いはない。
 */
export class LogoutUseCase {
  constructor(private readonly deps: LogoutDeps) {}

  async execute(command: LogoutCommand): Promise<UseCaseResult<LogoutOutput>> {
    const tokenHash = await this.deps.hasher.hash(command.sessionToken);
    const session = await this.deps.sessions.findByTokenHash(tokenHash);
    if (session === null) return ok({ revokedCount: 0 });

    const now = this.deps.clock.now();

    // 失効済み・期限切れのトークンに「全デバイスを落とす」権限を残さない。
    //
    // findByTokenHash は契約上「期限切れ・失効済みも返す」（判定は Domain 側）。
    // ここで確かめないと、盗まれたトークンを利用者が失効させた後も、攻撃者が
    // allDevices で永久に蹴り出し続けられる。失効機能そのものが無意味になる。
    // Origin 検証は防御にならない（ブラウザ外からは任意に付けられる）。
    //
    // 応答は成功のまま返す。区別させるとトークンの実在を探る手段になる。
    if (!session.isUsableAt(now)) return ok({ revokedCount: 0 });

    if (command.allDevices) {
      const revokedCount = await this.deps.sessions.revokeAllForUser(session.userId, now);
      // 未交換の認可コードも落とす。コードは 60 秒生きるので、ログアウト後も
      // そのコードを握っている相手がトークンを取れる窓が残る。利用者にとって
      // ログアウトは「このブラウザでの認可をここで止める」操作なので、
      // 進行中の認可だけ素通りするのは期待と合わない（#15）。
      await this.deps.codes.revokeUnconsumedByUser(session.userId, now);
      await settleSideEffects(
        "session.logout",
        this.deps.audit.record({
          event: "session.logout",
          userId: session.userId,
          outcome: "success",
          metadata: { allDevices: true, revokedCount },
        }),
      );
      return ok({ revokedCount });
    }

    const revoked = await this.deps.sessions.revoke(session.id, now);
    // このセッション中に発行された未交換コードだけを落とす（上と同じ理由）。
    await this.deps.codes.revokeUnconsumedBySession(session.id, now);
    await settleSideEffects(
      "session.logout",
      this.deps.audit.record({
        event: "session.logout",
        userId: session.userId,
        outcome: "success",
        metadata: { allDevices: false, sessionId: session.id },
      }),
    );
    return ok({ revokedCount: revoked ? 1 : 0 });
  }
}
