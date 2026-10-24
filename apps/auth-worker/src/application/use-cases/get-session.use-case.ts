import type { Session } from "../../domain/entities/session";
import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { TokenHasher } from "../ports/crypto.port";
import type { SessionRepository } from "../ports/session.repository";
import type { SideEffectScheduler } from "../ports/side-effect-scheduler.port";
import type { UserRepository } from "../ports/user.repository";
import { ok, type UseCaseResult } from "./types";

export type GetSessionCommand = {
  readonly sessionToken: string;
};

export type GetSessionOutput = {
  readonly session: Session;
  readonly userId: string;
} | null;

export type GetSessionDeps = {
  readonly sessions: SessionRepository;
  readonly users: UserRepository;
  readonly hasher: TokenHasher;
  readonly clock: Clock;
  readonly audit: AuditLogger;
  readonly sideEffects: SideEffectScheduler;
};

/**
 * セッショントークンを検証して、使えるセッションなら返す。
 *
 * 「無効なトークン」「期限切れ」「失効済み」「ユーザーが停止中」はすべて
 * null に畳み込む。理由を呼び出し元へ返すと、トークンの存在有無を
 * 推測させる材料になるため（仕様書 9）。
 *
 * ## 応答時間も畳み込む（#126 / 脅威モデル RR-15）
 *
 * **応答を畳み込んでも、応答時間が畳み込めていなければ同じことが漏れる。**
 * 以前はトークンが見つかったときだけ監査ログの INSERT を待っていたので、
 * 「このトークン値は DB に存在した」が所要時間として観測されえた。
 *
 * 書き込み（`audit.record()` と `sessions.touch()`）はすべて
 * `SideEffectScheduler` 経由にして応答経路から外してある。結果、
 * **応答を返すまでに待つのは SELECT だけ**になる。
 *
 * | 経路 | 応答までに待つ DB アクセス |
 * | --- | --- |
 * | トークン不一致 | `findByTokenHash` のみ |
 * | 失効・期限切れ | `findByTokenHash` のみ |
 * | ユーザーが停止中 | `findByTokenHash` + `findById` |
 * | 有効 | `findByTokenHash` + `findById` |
 *
 * **下 2 つが 1 回多いのは埋めていない。** 埋めるには実在しないトークンに
 * 対してもダミーの `findById` を打つことになるが、そこへ到達できるのは
 * **既に使えるトークンを持っている相手だけ**で、その相手が「このトークンは
 * まだ有効だ」と知っても得るものが無い（使えば分かる）。一方コストは
 * **未認証のリクエスト 1 本ごとに D1 のクエリが 1 回増える**ことで、
 * 公開エンドポイントに対する増幅になる。割に合わない。
 *
 * 漏れていたのは「DB に存在したか」で、それは上 2 つの区別である。
 * そこは揃えてある。
 *
 * 回数が揃っていることは `test/session-timing.test.ts` が
 * Repository の呼び出しを数えて固定している。**時間そのものは測らない** ——
 * isolate のノイズに埋もれて、差があっても無くても緑になるため。
 */
export class GetSessionUseCase {
  constructor(private readonly deps: GetSessionDeps) {}

  async execute(command: GetSessionCommand): Promise<UseCaseResult<GetSessionOutput>> {
    const tokenHash = await this.deps.hasher.hash(command.sessionToken);
    const session = await this.deps.sessions.findByTokenHash(tokenHash);
    if (session === null) return ok(null);

    const now = this.deps.clock.now();
    if (!session.isUsableAt(now)) {
      // 応答経路から外す。ここで INSERT を待つと、所要時間が
      // 「トークンが見つかった」ことを教える（#126）。
      await this.deps.sideEffects.schedule(
        "session.rejected",
        this.deps.audit.record({
          event: "session.rejected",
          userId: session.userId,
          outcome: "failure",
          reason: session.isRevoked ? "revoked" : "expired",
        }),
      );
      return ok(null);
    }

    // 停止・削除されたユーザーのセッションは、期限内でも通さない。
    // セッションを引いてからでないと userId が分からないので、ここは直列。
    const user = await this.deps.users.findById(session.userId);
    if (user === null || !user.isActive) {
      await this.deps.sideEffects.schedule(
        "session.rejected",
        this.deps.audit.record({
          event: "session.rejected",
          userId: session.userId,
          outcome: "failure",
          reason: "user_not_active",
        }),
      );
      return ok(null);
    }

    // 最終アクセスの更新はセッション一覧の表示用。失敗しても認証は成立させる。
    await this.deps.sideEffects.schedule(
      "session.touch",
      this.deps.sessions.touch(session.id, now),
    );

    return ok({ session, userId: session.userId });
  }
}
