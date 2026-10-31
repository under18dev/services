import type { CardEventRecorder, CardRepository, Clock, NfcOutcome } from "../ports";
import { outcomeErr, outcomeOk } from "../ports";

export type DelegatedReinstateCardToIssuedInput = {
  /**
   * admin-worker が確認済みの、操作者（運営）の userId。
   *
   * **ここでは検証しない。** `delegated-reinstate-card.use-case.ts` と
   * 同じ理由——ここへ辿り着けること自体が Service Binding で保証されている。
   */
  readonly actorUserId: string;
  readonly cardId: string;
};

/**
 * 運営（admin-worker 経由）が、無効化された所有者の無い（`issued` 由来の）
 * カード 1 枚を `issued` へ戻す（#436、`reinstateBatchToIssuedCards` の
 * 単発版）。
 *
 * ## なぜこれが要るのか——`reinstateCard` を 1 枚に対して呼ぶと壊れていた
 *
 * **#450 のレビューで見つかった時点では**、`DelegatedReinstateCardUseCase`
 * （#434、`disabled` → `active`）は `owner_user_id` を見ずに `active` を
 * 書いていた。admin-worker の `CardActions` が `disabled` のカードすべて
 * に無条件で「復帰させる」（`reinstateCard` 行き）を出していたので、
 * バッチ一括無効化で止めた未紐づけカードを 1 枚だけ「復帰させる」と、
 * 所有者の無いまま `active` になる壊れた行ができた——
 * `DelegatedReinstateBatchToIssuedCardsUseCase` の冒頭が警告する形
 * そのもの。**同じレビューで `reinstateAsAdmin` の WHERE 句に
 * `owner_user_id is not null` を足したので、いまは `reinstateCard` を
 * 所有者の無いカードへ直接 POST しても何も起きない**（`CardRepository`
 * の `reinstateAsAdmin` 宣言を参照）。この UseCase は不変条件の最後の砦
 * ではなく、**所有者の無いカードに正しい遷移先（`issued`）を提供する**
 * ための経路——`reinstateCard` が守る先（`active`）とは違うので、
 * 1 本にまとめず別の UseCase のままにしてある。
 *
 * ## 理由コードでは絞らない
 *
 * `DelegatedReinstateBatchToIssuedCardsUseCase`（バッチ版）は
 * `disabled_reason = ADMIN_BATCH_DISABLED_REASON` の行だけを対象にする
 * ——「このバッチの一括無効化で止めた行だけ」を戻すため。**こちらは
 * 1 枚を名指しで戻す操作**なので、同じ絞り込みは要らない。単発の運営
 * 操作（`admin_action`）で止めた未紐づけカードもこれで戻せるほうが
 * 実務に合う、という判断（`CardRepository.reinstateToIssuedAsAdmin` の
 * 宣言を参照。選べる余地があることは認識している）。
 *
 * ## 冪等
 *
 * 既に `issued` のカードへもう一度叩いても失敗にしない
 * （`DelegatedReinstateCardUseCase` と同じ判断）。所有者のいる
 * `disabled` カードは対象外——`reinstateToIssuedAsAdmin` の WHERE 句
 * （`owner_user_id is null`）がそれを守る。
 *
 * ## 監査: 新しいイベント名は増やさない
 *
 * `card.reinstated`（#427）を使い回す。`metadata` は
 * `DelegatedReinstateCardUseCase` と同じ形（`actingAsAdmin: true` のみ）
 * ——戻した先が `active` か `issued` かは、行の現在の `status` から分かる。
 */
export class DelegatedReinstateCardToIssuedUseCase {
  constructor(
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: DelegatedReinstateCardToIssuedInput): Promise<NfcOutcome<null>> {
    const card = await this.cards.findById(input.cardId);
    if (card === null || card.ownerUserId !== null) return outcomeErr({ kind: "card_not_found" });

    if (card.status !== "issued") {
      const now = this.clock.now();
      const reinstated = await this.cards.reinstateToIssuedAsAdmin(input.cardId, now);
      if (!reinstated) return outcomeErr({ kind: "card_not_found" });

      await this.events.record({
        cardId: input.cardId,
        event: "card.reinstated",
        actorUserId: input.actorUserId,
        metadata: { actingAsAdmin: true },
      });
    }

    return outcomeOk(null);
  }
}
