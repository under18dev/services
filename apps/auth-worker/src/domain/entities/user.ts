import { UserNotActiveError } from "../errors/domain-error";
import type { AuthMethod } from "./session";

export type UserStatus = "active" | "suspended" | "deleted";

export type UserProps = {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly status: UserStatus;
  /**
   * 管理権限を持つか（仕様書 §14.1 決定 8）。
   *
   * ロールの列挙ではなく 1 ビットなのは、この旗が決めることが 1 つしか
   * 無いため —— 「この利用者に決定 8 を適用するか」。詳しい根拠は
   * `packages/db/src/schema/users.ts` の `isAdmin` 側に書いた。
   */
  readonly isAdmin: boolean;
  /**
   * 論理削除の時刻。`status` とは独立に立ちうるので、認証可否の判定には
   * 両方を見る必要がある（status だけ見ると削除済みユーザーがログインできる）。
   */
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * ユーザー。
 *
 * `id` は不変で、OIDC の `sub` になる。username / email は変更されうるため
 * 同一性の判定には使わない（仕様書 6.2）。
 */
export class User {
  private constructor(private readonly props: UserProps) {}

  static fromPersistence(props: UserProps): User {
    return new User(props);
  }

  get id(): string {
    return this.props.id;
  }
  get username(): string {
    return this.props.username;
  }
  get displayName(): string {
    return this.props.displayName;
  }
  get email(): string {
    return this.props.email;
  }
  get emailVerified(): boolean {
    return this.props.emailVerified;
  }
  get status(): UserStatus {
    return this.props.status;
  }
  get isAdmin(): boolean {
    return this.props.isAdmin;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get isActive(): boolean {
    return this.props.status === "active" && this.props.deletedAt === null;
  }

  /** ログイン・トークン発行の前に必ず通す。停止・削除済みの利用を一箇所で止める。 */
  assertCanAuthenticate(): void {
    if (!this.isActive) {
      throw new UserNotActiveError(this.props.deletedAt !== null ? "deleted" : this.props.status);
    }
  }

  /**
   * この認証方式でログインを成立させてよいか（仕様書 §14.1 決定 8 / #40）。
   *
   * 管理者には Passkey しか認めない。メール OTP は**メールボックスの支配権が
   * そのままアカウントの支配権になる**方式で、一般利用者にはその取引が妥当でも
   * （決定 2 により OTP は常設のログイン経路として残る）、管理権限に対しては
   * メールプロバイダ側の乗っ取り 1 件が IdP 全体の管理操作に直結する。
   *
   * 判定を Domain に置くのは `isActive` と同じ理由で、認証経路が増えるたびに
   * 同じ条件を書き写させないため。**呼び出し元が「管理者かどうか」を見て
   * 分岐するのではなく、必ずこの関数に訊くこと。**
   */
  permitsAuthMethod(method: AuthMethod): boolean {
    return !this.props.isAdmin || method === "passkey";
  }

  /**
   * **いま手元にあるこのセッションで、管理者として振る舞ってよいか**
   * （決定 8 / 脅威モデル RR-5）。
   *
   * `isAdmin` と `permitsAuthMethod` を 1 つにまとめただけだが、**この 2 つを
   * 別々に見るのをやめることがこの関数の目的**である。
   *
   * 決定 8 の「管理者は Passkey 必須」は長らく `IssueSessionUseCase` の
   * 入口側にしか無かった。つまり **`sessions` に OTP の行が無いことが前提**で、
   * 権限の判定はその前提に寄りかかって `users.is_admin` だけを見ていた。
   * ところが権限の付与は `grantAdminSql` と `revokeNonPasskeySessionsSql` の
   * 2 文に分かれており、その間に張られた（あるいは revoke が落ちて
   * 生き残った）OTP セッションは**前提の外**に出る。前提が崩れた瞬間に
   * 権限の判定は何も守らなくなる。
   *
   * だから**入口ではなく使う側で毎回確かめる**。ログイン時に 1 度通った
   * ことではなく、**この 1 回の操作がどの認証方式に支えられているか**を
   * 見る。`sessions.auth_method` は発行時に決まって以後変わらないので、
   * 追加の問い合わせも要らない。
   *
   * **`permitsAuthMethod` に乗せているのは意図的である。** 決定 8 を緩めて
   * 管理者の OTP ログインを許す日が来たら、権限の判定も同時に緩むべきで、
   * **片方だけ緩んだ状態（ログインは通るが権限が出ない / その逆）を
   * 作れないようにしてある。** 逆に言うと、**`permitsAuthMethod` を
   * 緩めるときは、ここも緩むことを承知で緩めること。**
   */
  actsAsAdminWith(method: AuthMethod): boolean {
    return this.props.isAdmin && this.permitsAuthMethod(method);
  }

  /**
   * 認証器をあと `remainingAfterRemoval` 本残す形で 1 本外してよいか（#75 / #83）。
   *
   * 一般利用者は 0 本まで外せる。決定 2 によりメール OTP が残るので締め出されず、
   * 逆に「最後の 1 本は外せない」設計にすると、盗まれた端末の Credential が
   * それ 1 本だけだった利用者が危険な認証器を外せなくなる（#75 が塞いだ穴）。
   *
   * **管理者だけは例外。** 決定 8 で OTP を塞いでいるため、最後の 1 本を外すと
   * ログイン手段が 0 になる。そこで残るのは「締め出された管理者を運用者が
   * 直接 DB で救う」か「決定 8 を緩めて OTP を開ける」かのどちらかで、
   * 後者はこの決定そのものの無効化になる。外したいときは先に別の認証器を
   * 登録させる —— 本数が 2 本以上あれば、危険な 1 本はいつでも外せる。
   */
  canRemovePasskey(remainingAfterRemoval: number): boolean {
    return !this.props.isAdmin || remainingAfterRemoval >= 1;
  }

  /**
   * OIDC の `profile` / `email` scope に対応する claim。scope 判定は Application 側で行う。
   *
   * **`isAdmin` はここに出さない。** RP に配るトークンへ載せると、u18 Identity の
   * 内部の権限がそのまま各サービスの権限判断に使われ始める。組織・チーム権限管理は
   * 仕様書 §1.2 の非目標であり、この旗が意味を持つのはこの IdP の中だけである。
   */
  toClaims(): Record<string, unknown> {
    return {
      sub: this.props.id,
      preferred_username: this.props.username,
      name: this.props.displayName,
      email: this.props.email,
      email_verified: this.props.emailVerified,
      updated_at: Math.floor(this.props.updatedAt.getTime() / 1000),
    };
  }

  snapshot(): UserProps {
    return { ...this.props };
  }
}
