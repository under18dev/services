import { newSessionId } from "@u18/domain";
import type { Session, AuthMethod } from "../../domain/entities/session";
import { TokenLifetime, expiresAt } from "../../domain/services/token-lifetime";
import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { IpHasher, RandomTokenGenerator, TokenHasher } from "../ports/crypto.port";
import type { SessionRepository } from "../ports/session.repository";
import type { UserRepository } from "../ports/user.repository";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type IssueSessionCommand = {
  readonly userId: string;
  /** どの方式で本人確認が済んだか。再認証の要否判断に残す。 */
  readonly authMethod: AuthMethod;
  readonly userAgent: string | null;
  /** 生 IP。保存前にハッシュ化する（仕様書 9 Privacy）。 */
  readonly ip: string | null;
};

export type IssueSessionOutput = {
  readonly session: Session;
  /**
   * 平文のセッショントークン。
   *
   * **この瞬間にしか存在しない。** DB にはハッシュしか保存しないので、
   * ここで Cookie に載せ損ねたら二度と取り出せない。
   */
  readonly token: string;
};

export type IssueSessionDeps = {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly hasher: TokenHasher;
  readonly ipHasher: IpHasher;
  readonly tokens: RandomTokenGenerator;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * 本人確認が済んだユーザーにセッションを発行する。
 *
 * **このユースケース自体は認証を行わない。** 呼び出し元（OTP 検証・Passkey 検証）が
 * 本人確認を終えていることが前提。したがって、認証フロー以外からは呼ばないこと。
 */
export class IssueSessionUseCase {
  constructor(private readonly deps: IssueSessionDeps) {}

  async execute(command: IssueSessionCommand): Promise<UseCaseResult<IssueSessionOutput>> {
    const user = await this.deps.users.findById(command.userId);
    if (user === null) return err("not_found", "user does not exist");

    // 停止・削除済みのユーザーには、認証が通っていてもセッションを出さない。
    if (!user.isActive) {
      await this.deps.audit.record({
        event: "session.issue",
        userId: user.id,
        outcome: "failure",
        reason: "user_not_active",
      });
      return err("forbidden", "user cannot sign in");
    }

    // 管理者はメール OTP ではセッションを得られない（仕様書 §14.1 決定 8 / #40）。
    //
    // **ここが決定 8 の強制点である。** 管理操作の入口を 1 つずつ守るのではなく、
    // 「管理者の OTP セッションをそもそも存在させない」ことで守る。管理操作が
    // 後から増えても、その入口が認可チェックを書き忘れることで穴が開くのを防ぐ。
    //
    // 呼び出し元（`VerifyEmailOtpUseCase`）はこの失敗を `invalid_code` に畳むので、
    // 応答から「このアドレスは管理者のものだ」とは読めない。管理者の列挙は
    // 攻撃対象を絞る材料になるため、区別を外へ出さない。
    if (!user.permitsAuthMethod(command.authMethod)) {
      await this.deps.audit.record({
        event: "session.issue",
        userId: user.id,
        outcome: "failure",
        reason: "admin_requires_passkey",
        metadata: { authMethod: command.authMethod },
      });
      return err("forbidden", "administrators must sign in with a passkey");
    }

    const now = this.deps.clock.now();
    const token = this.deps.tokens.generate();

    // トークンと IP のハッシュは互いに独立なので同時に走らせる。
    // ここは allSettled ではなく all —— どちらも保存に必須で、
    // 失敗を握り潰すと「IP ハッシュ無しのセッション」が静かに生まれる。
    const [tokenHash, ipHash] = await Promise.all([
      this.deps.hasher.hash(token),
      command.ip === null ? Promise.resolve(null) : this.deps.ipHasher.hash(command.ip),
    ]);

    const session = await this.deps.sessions.create({
      id: newSessionId(),
      userId: user.id,
      tokenHash,
      expiresAt: expiresAt(now, TokenLifetime.sessionMs),
      authMethod: command.authMethod,
      userAgent: command.userAgent,
      ipHash,
    });

    // 監査ログは本筋ではない。書けなくてもログインは成立させる。
    //
    // `ipHash` / `userAgent` をここで渡さなくなったのは #122。発信元は
    // `RequestScopedAuditLogger` が全イベントに付けるようになった。
    // ここだけ手で渡し続けると、**同じ値を 2 つの経路が決めることになり**、
    // 片方を直したときにイベントごとに食い違う。
    // `last_active_at` は保持期間（最終利用から 1 年）の起点である（#286）。
    // **ここでしか書かない** —— `sessions.touch()` は認証付き要求が届く
    // たびに動き、`SameSite=Lax` なので他サイトからのトップレベル遷移でも
    // 更新される。あれは「本人が使った」を測っていない。
    //
    // 監査ログと同じく本筋ではない。書けなくてもログインは成立させる
    // （書けなければ起点が古いままになり、**洗い出しの対象に入る側**へ
    // 倒れる。消す前に人が見るので、黙って消えることはない）。
    await settleSideEffects(
      "session.issue",
      this.deps.audit.record({
        event: "session.issue",
        userId: user.id,
        outcome: "success",
        metadata: { authMethod: command.authMethod, sessionId: session.id },
      }),
      this.deps.users.touchLastActive(user.id, now),
    );

    return ok({ session, token });
  }
}
