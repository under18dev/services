import { isServableTargetUrl } from "../services/target-url";

/**
 * カードの状態（`nfc_cards.status` と 1 対 1）。
 *
 * 「所有者がいるか」を `ownerUserId` の null 判定だけに任せず、独立した
 * 状態として持つ理由は `disabled` にある。紛失したカードは
 * 「所有者を外す」だけでは止まらない —— 所有者を外した瞬間に
 * `issued` と区別がつかなくなり、拾った人間が紐づけコードを持っていれば
 * 自分のものにできてしまう。無効化は所有者の有無と直交した軸にする。
 */
export type CardStatus = "issued" | "active" | "disabled";

export type CardProps = {
  readonly id: string;
  readonly ownerUserId: string | null;
  readonly targetUrl: string | null;
  readonly status: CardStatus;
  readonly claimCodeHash: string | null;
  readonly claimCodeIssuedAt: Date | null;
  readonly claimedAt: Date | null;
  readonly transferCount: number;
  readonly disabledAt: Date | null;
  readonly disabledReason: string | null;
  readonly batch: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * 紐づけコードの有効期間。
 *
 * 発行から 180 日。文化祭で配ったカードを後日ゆっくり紐づける運用を
 * 想定しつつ、無期限にはしない。未使用のコードが印刷物として残り続けると、
 * 「配布ロットごと紛失していたことに後から気付く」場合に、止める手段が
 * ロット単位の無効化しか無くなる。
 */
export const CLAIM_CODE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * NFC カード。
 *
 * このエンティティは「誰がこのカードに何をしてよいか」だけを決める。
 * セッションの検証は auth-worker、永続化は Infrastructure の責務。
 */
export class Card {
  private constructor(private readonly props: CardProps) {}

  static fromPersistence(props: CardProps): Card {
    return new Card(props);
  }

  get id(): string {
    return this.props.id;
  }
  get ownerUserId(): string | null {
    return this.props.ownerUserId;
  }
  get targetUrl(): string | null {
    return this.props.targetUrl;
  }
  get status(): CardStatus {
    return this.props.status;
  }
  get claimCodeHash(): string | null {
    return this.props.claimCodeHash;
  }
  get claimedAt(): Date | null {
    return this.props.claimedAt;
  }
  get transferCount(): number {
    return this.props.transferCount;
  }
  get disabledAt(): Date | null {
    return this.props.disabledAt;
  }
  get disabledReason(): string | null {
    return this.props.disabledReason;
  }
  get batch(): string | null {
    return this.props.batch;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get isDisabled(): boolean {
    return this.props.status === "disabled";
  }

  /**
   * この userId がこのカードの所有者か。
   *
   * **呼び出し元が申告した userId をそのまま渡してはならない**（仕様書 4.2）。
   * 渡してよいのは auth-worker のセッション照会から得た userId だけ。
   * この関数自体はその出所を知らないので、Application 層が責任を持つ。
   */
  isOwnedBy(userId: string): boolean {
    return this.props.ownerUserId !== null && this.props.ownerUserId === userId;
  }

  /**
   * リダイレクト解決に使えるカードか。
   *
   * 3 つの条件を 1 つの真偽値に畳んでいるのが肝。呼び出し側に
   * 「未割り当て」「無効化済み」「遷移先未設定」を区別させると、
   * その区別がそのまま応答の差になり、カードの実在と状態が漏れる
   * （仕様書 9 の列挙対策と同じ考え方）。
   */
  isResolvable(): boolean {
    if (this.props.status !== "active") return false;
    if (this.props.ownerUserId === null) return false;
    if (this.props.targetUrl === null) return false;
    // 保存済みの値も配信直前にもう一度 https: か確かめる。
    return isServableTargetUrl(this.props.targetUrl);
  }

  /**
   * 紐づけコードを受け付けられる状態か。
   *
   * `active` を含めないのは、所有者がいるカードに他人の紐づけコードが
   * 通ってはならないため。所有権の移転は「現所有者が release する →
   * 新しいコードが出る」の順でしか起こらない（ReleaseCardUseCase）。
   */
  canBeClaimedAt(now: Date): boolean {
    if (this.props.status !== "issued") return false;
    if (this.props.claimCodeHash === null) return false;
    if (this.props.claimCodeIssuedAt === null) return false;
    return now.getTime() - this.props.claimCodeIssuedAt.getTime() < CLAIM_CODE_TTL_MS;
  }

  snapshot(): CardProps {
    return { ...this.props };
  }
}
