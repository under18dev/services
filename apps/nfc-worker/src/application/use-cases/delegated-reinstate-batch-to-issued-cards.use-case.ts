import type { CardEventRecorder, CardRepository, Clock, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";

export type DelegatedReinstateBatchToIssuedCardsInput = {
  /**
   * admin-worker が確認済みの、操作者（運営）の userId。
   *
   * **ここでは検証しない。** `delegated-batch-disable-cards.use-case.ts` と
   * 同じ理由——ここへ辿り着けること自体が Service Binding で保証されている。
   */
  readonly actorUserId: string;
  readonly batch: string;
};

export type DelegatedReinstateBatchToIssuedCardsOutput = {
  /** 実際に `issued` へ戻せたカードの ID。0 件もありうる（該当なし）。 */
  readonly cardIds: readonly string[];
};

/**
 * batch 単位で、一括無効化された `issued` 由来のカードを一括で `issued`
 * へ戻す（#436「一括で止められるのに一括で戻せない」）。
 *
 * ## `DelegatedBatchDisableCardsUseCase` の逆
 *
 * `disable` → `issued` ではなく `disabled` → `issued`。対象は
 * `CardRepository.reinstateBatchToIssuedAsAdmin` の WHERE 句（`batch` ·
 * `disabled` · `owner_user_id is null` · `disabled_reason =
 * ADMIN_BATCH_DISABLED_REASON`）がそのまま表明である。
 *
 * ## `DelegatedReinstateCardUseCase`（#434、`disabled` → `active`）とは
 * 別の UseCase にした
 *
 * 対象が違う。あちらは所有者・遷移先を持つカードが前提で、戻した先も
 * `active`。こちらは所有者の無い `issued` 由来のカードが前提で、戻した
 * 先も `issued`。1 本にまとめると、分岐の条件を間違えたときに
 * **所有者の無いカードが `active` になる壊れた行**ができる
 * （`docs/nfc-cards-operations.md` §6）——`DelegatedBatchDisableCardsUseCase`
 * が `disableCard` と別の UseCase である理由と同じ判断。
 *
 * ## 「このバッチの一括無効化で止めた行だけ」を戻す
 *
 * **`batch` が一致するだけでは戻さない。** `batch` 列はカードの配布ロット
 * （発行時に決まる）であって、無効化した操作を表さない——同じロットの
 * カードを、運営が単発操作（`DelegatedDisableCardUseCase`）で個別に
 * 無効化していることがありうる。その 1 枚まで一括復帰が巻き込むと、
 * 個別の判断で止めた理由を一括操作が消すことになる。`disabled_reason`
 * を一括無効化専用の値にして区別する——詳しい設計意図は
 * `domain/services/disabled-reason.ts` を参照。
 *
 * ## 冪等性は「該当なし」として表れる
 *
 * `reinstateBatchToIssuedAsAdmin` の WHERE 句は、既に `issued` へ戻った
 * カードを自然に除外する（`status = 'disabled'` を要求するため）。
 * 同じバッチへ二度叩いても、2 回目は対象 0 件になるだけで失敗にはならない
 * （`DelegatedBatchDisableCardsUseCase` と同じ判断）。
 *
 * ## 監査: 新しいイベント名は増やさない
 *
 * `card.reinstated`（#427、`DelegatedReinstateCardUseCase` が新設）を
 * 使い回す。`metadata.batch` でこの一括操作の一部だったことを残す——
 * `DelegatedBatchDisableCardsUseCase` の `card.disabled` と対称。
 */
export class DelegatedReinstateBatchToIssuedCardsUseCase {
  constructor(
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: DelegatedReinstateBatchToIssuedCardsInput,
  ): Promise<NfcOutcome<DelegatedReinstateBatchToIssuedCardsOutput>> {
    const now = this.clock.now();
    const rows = await this.cards.reinstateBatchToIssuedAsAdmin(input.batch, now);

    for (const row of rows) {
      await this.events.record({
        cardId: row.id,
        event: "card.reinstated",
        actorUserId: input.actorUserId,
        metadata: { actingAsAdmin: true, batch: input.batch },
      });
    }

    return outcomeOk({ cardIds: rows.map((row) => row.id) });
  }
}
