import type {
  CardEventRecorder,
  CardRepository,
  CardView,
  Clock,
  IdentityGateway,
  NfcOutcome,
} from "../ports";
import { outcomeErr, outcomeOk } from "../ports";
import { requireUserId } from "./authenticate";
import { toCardView } from "./card-view";

export type DisableCardInput = {
  readonly sessionToken: string | undefined;
  readonly cardId: string;
  /** 理由コード。自由文は受け取らない（監査ログに任意文字列を書かせない）。 */
  readonly reason: "lost" | "unused";
};

/**
 * カードを無効化する（仕様書 10「カード紛失時の無効化」）。
 *
 * ## 片道であること
 *
 * 一度 `disabled` にしたカードを、所有者は自分で戻せない。
 * 戻せるようにすると、無効化が「アカウントを奪われたら無かったことに
 * できる操作」になり、紛失対策として意味を失う。
 * 復帰は運営の操作（DB 直接 or 将来の管理 API）に限る。
 *
 * ## 所有者を外さない
 *
 * 無効化しても `owner_user_id` は残す。外すと `issued` と区別が付かなくなり、
 * 拾った人間が紐づけコードを持っていた場合に自分のものにできてしまう。
 * 「誰のカードだったか」は紛失の問い合わせにも要る。
 *
 * 無効化の効果は次のタップから出る。リダイレクトを 302 + `no-store` で
 * 返しているため、ブラウザも中間キャッシュも古い遷移先を握っていない
 * （redirect.routes.ts の コメントを参照）。
 */
export class DisableCardUseCase {
  constructor(
    private readonly identity: IdentityGateway,
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: DisableCardInput): Promise<NfcOutcome<CardView>> {
    const actor = await requireUserId(this.identity, input.sessionToken);
    if (!actor.ok) return actor;

    const card = await this.cards.findById(input.cardId);
    if (card === null || !card.isOwnedBy(actor.value)) {
      return outcomeErr({ kind: "card_not_found" });
    }

    const now = this.clock.now();
    // 既に無効化済みでも成功として扱う（冪等）。紛失の報告は慌てて
    // 二度押されるもので、2 回目を失敗にすると「止まらなかった」と誤解される。
    if (!card.isDisabled) {
      const disabled = await this.cards.disable(input.cardId, actor.value, input.reason, now);
      if (!disabled) return outcomeErr({ kind: "card_not_found" });

      await this.events.record({
        cardId: input.cardId,
        event: "card.disabled",
        actorUserId: actor.value,
        metadata: { reason: input.reason },
      });
    }

    const fresh = await this.cards.findById(input.cardId);
    if (fresh === null) return outcomeErr({ kind: "card_not_found" });
    return outcomeOk(toCardView(fresh));
  }
}
