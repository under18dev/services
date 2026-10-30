import { isServableTargetUrl } from "../services/target-url";

/**
 * カードの状態（`nfc_cards.status` と 1 対 1）。
 *
 * 「所有者がいるか」を `ownerUserId` の null 判定だけに任せず、独立した
 * 状態として持つ理由は `disabled` にある。紛失したカードは
 * 「所有者を外す」だけでは止まらない —— 所有者を外した瞬間に `issued` と
 * 区別がつかなくなり、**#358 以降は拾った人がタップしてログインするだけで
 * 自分のものにできてしまう。** 無効化は所有者の有無と直交した軸にする。
 */
export type CardStatus = "issued" | "active" | "disabled";

export type CardProps = {
  readonly id: string;
  readonly ownerUserId: string | null;
  readonly targetUrl: string | null;
  readonly status: CardStatus;
  readonly claimedAt: Date | null;
  readonly transferCount: number;
  readonly disabledAt: Date | null;
  readonly disabledReason: string | null;
  readonly batch: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

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
   * いま紐づけを受け付けられるカードか（#358）。
   *
   * **これが「タップした人のものになる」窓である。** 条件は 2 つだけ ——
   * `issued` であること、所有者がいないこと。`ownerUserId` の判定が
   * 重複して見えるが、`status` と所有者は直交した軸なので（上の
   * `CardStatus` を参照）、片方だけを見ると整合しない行が通る。
   *
   * ## `active` を含めない
   *
   * 所有者がいるカードを他人が奪えてはならない。所有権の移転は
   * 「現所有者が手放す（`issued` へ戻る）→ 受け取った人がタップして
   * 紐づける」の順でしか起こらない（`ReleaseCardUseCase`）。
   *
   * ## `disabled` を含めない
   *
   * 紛失して止めたカードが、拾った人のものになっては意味が無い。
   * **ここが `disabled` の本体である。**
   */
  isClaimable(): boolean {
    return this.props.status === "issued" && this.props.ownerUserId === null;
  }

  snapshot(): CardProps {
    return { ...this.props };
  }
}
