import type { Session } from "../../domain/entities/session";
import type { AuditLogger, NotPersistedAuditEventName } from "../ports/audit-log.port";
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
  /**
   * **このセッションで管理者として振る舞ってよいか**（§14.1 決定 8）。
   *
   * `users.is_admin` そのものではない。**Passkey で張られたセッションで
   * なければ false になる**（`User.actsAsAdminWith`）。アカウントに旗が
   * 立っていることと、いま目の前の 1 回の操作を管理者として通してよいことは
   * 別で、ここが返すのは後者である。
   *
   * **`user` ごと返さない。** 呼び出し元が要るのは認可に使う 1 ビットで、
   * `User` を渡すとメールアドレスまで RPC の向こうへ運べてしまう（#187）。
   */
  readonly isAdmin: boolean;
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

    const isAdmin = user.actsAsAdminWith(session.authMethod);
    if (user.isAdmin && !isAdmin) {
      // **ここを無言で false にしない。** 決定 8 は `IssueSessionUseCase` が
      // 入口で塞いでいるので、この状態は正常な経路では生まれない。出たなら
      // 付与の 2 文目（`revokeNonPasskeySessionsSql`）が流れていないか、
      // 付与と OTP ログインが競ったかのどちらかで、**権限を剥がしたまま
      // 放置された runbook §10.5 の復旧**も同じ形に見える。
      //
      // `audit_logs` へは書かない。出せるのは「有効なセッションを持つ
      // 管理者」だけなので外から誘発できる量ではないが、リクエストごとに
      // D1 へ 1 行増える形は避ける（`admin.denied` と同じ判断）。しかも
      // ここは応答時間を畳み込んでいる経路で、INSERT を待たせたくない。
      console.warn(
        JSON.stringify({
          event: "admin.session_not_passkey" satisfies NotPersistedAuditEventName,
          userId: session.userId,
          sessionId: session.id,
          authMethod: session.authMethod,
        }),
      );
    }

    return ok({ session, userId: session.userId, isAdmin });
  }
}
