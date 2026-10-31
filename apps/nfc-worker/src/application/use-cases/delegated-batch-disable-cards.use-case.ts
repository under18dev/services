import { ADMIN_BATCH_DISABLED_REASON } from "../../domain/services/disabled-reason";
import type { CardEventRecorder, CardRepository, Clock, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";

export type DelegatedBatchDisableCardsInput = {
  /**
   * admin-worker が確認済みの、操作者（運営）の userId。
   *
   * **ここでは検証しない。** `delegated-disable-card.use-case.ts` と
   * 同じ理由——ここへ辿り着けること自体が Service Binding で保証されている。
   */
  readonly actorUserId: string;
  readonly batch: string;
};

export type DelegatedBatchDisableCardsOutput = {
  /** 実際に無効化できたカードの ID。0 件もありうる（該当なし）。 */
  readonly cardIds: readonly string[];
};

/**
 * batch 単位で `issued`（未紐づけ）のカードを一括無効化する（#427 の
 * 数え上げ「配布前の箱ごと盗難」から）。
 *
 * ## `active` は対象外。「issued のみ」という決定
 *
 * **誰かのものになっているカードを、バッチ名が一致するというだけで
 * 巻き込まない。** 想定している被害（配布前の箱ごと盗難）では、
 * 被害に遭うカードは全部 `issued`（まだ誰も登録していない）——
 * `active` まで含める具体的な場面が書けないので、含めない。
 *
 * ## これが初めて「issued を無効化する」経路を作る
 *
 * `disableAsAdmin` / 所有者本人の `disable`（`cards.routes.ts`）は、
 * これまで `active` のカードしか対象にできなかった。**押し間違いで
 * 1 枚だけ盗まれたカードを止めたい、という単発の場面に口が無いまま
 * 一括だけ作ると、一括のほうが危ない操作なのに安全な単発版が無い**
 * という順序になる。`CardRepository.disableAsAdmin` の WHERE 句を
 * `active | issued` へ広げ、単発でも `issued` を無効化できるようにした
 * （本 PR に同梱）。
 *
 * ## 戻す経路（#436）
 *
 * `DelegatedReinstateCardUseCase`（#434）は `disabled` → `active` で、
 * 元々 `active` だったカードを前提にしている（所有者・遷移先をそのまま
 * 残す設計）。ここで無効化するカードは元々 `issued`（所有者なし）
 * なので、戻すなら `disabled` → `issued` であるべきで、`reinstateCard`
 * をそのまま転用すると**所有者の無いカードが `active` になる**、
 * `docs/nfc-cards-operations.md` §6 が警告する壊れた行ができる。
 * **`DelegatedReinstateBatchToIssuedCardsUseCase`（#436）がこの逆を持つ。**
 *
 * ## 冪等性は「該当なし」として表れる
 *
 * `disableBatchAsAdmin` の WHERE 句（`status = 'issued'`）は、既に
 * 無効化済みのカードを自然に除外する。同じバッチへ二度叩いても、
 * 2 回目は対象 0 件になるだけで失敗にはならない。
 *
 * ## 監査: 新しいイベント名は増やさない。**理由コードは増やした**（#436）
 *
 * 対象カードの数ぶん `card.disabled` を書く。イベント名は単発の運営操作
 * （`DelegatedDisableCardUseCase`）と同じ `card.disabled` を使い、
 * `metadata.batch` でこの一括操作の一部だったことを残す——「どのカードが
 * 止まったか」は `cardId` から、「どの一括操作でか」は `metadata.batch`
 * から、どちらも後から引ける。
 *
 * **`disabled_reason` だけは単発操作と別の値（`ADMIN_BATCH_DISABLED_REASON`）
 * にした。** 以前は単発操作と同じ `"admin_action"` を使っていたが、
 * **一括復帰（#436）が「このバッチ名で一括無効化された行だけ」を戻す
 * ために、単発操作と区別できる値が要る**——`batch` 列はカードの配布
 * ロットであって無効化した操作を表さないので、`batch` が一致するだけでは
 * 「一括無効化で止めたか」を判定できない。理由は `domain/services/
 * disabled-reason.ts` を参照。イベントの `metadata.reason` も同じ値に
 * 揃えてある（1 つの操作が 2 つの違う文字列で説明される状態を増やさない）。
 *
 * **`nfc_cards.disabled_reason` の語彙は、まだ複数の出どころが食い
 * 違っている**（#427 で気づいた。全体を揃えるのは本 PR の範囲外）:
 *
 * |                    | 値                                              |
 * | ------------------ | ----------------------------------------------- |
 * | schema のコメント  | `"lost"`, `"abuse"`, `"ops"`（例として）        |
 * | 利用者が選べる値    | `lost` \| `unused`（`cards.routes.ts` の `POST /:cardId/disable`） |
 * | 単発の運営操作      | `admin_action`（`AdminDisableCardUseCase` / `DelegatedDisableCardUseCase`） |
 * | 一括無効化（本 UseCase） | `admin_batch`（#436、`ADMIN_BATCH_DISABLED_REASON`） |
 * | 利用者向け文書      | 「なくした・盗られた」としか書かない            |
 *
 * 実装に型の制約が無いので、どれが正しいかを機械が言わない。
 */
export class DelegatedBatchDisableCardsUseCase {
  constructor(
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: DelegatedBatchDisableCardsInput,
  ): Promise<NfcOutcome<DelegatedBatchDisableCardsOutput>> {
    const now = this.clock.now();
    const rows = await this.cards.disableBatchAsAdmin(
      input.batch,
      ADMIN_BATCH_DISABLED_REASON,
      now,
    );

    for (const row of rows) {
      await this.events.record({
        cardId: row.id,
        event: "card.disabled",
        actorUserId: input.actorUserId,
        metadata: { reason: ADMIN_BATCH_DISABLED_REASON, actingAsAdmin: true, batch: input.batch },
      });
    }

    return outcomeOk({ cardIds: rows.map((row) => row.id) });
  }
}
