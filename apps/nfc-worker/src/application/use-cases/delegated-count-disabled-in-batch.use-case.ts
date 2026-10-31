import type { CardRepository, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";

export type DelegatedCountDisabledInBatchInput = {
  readonly batch: string;
};

/**
 * batch 一括復帰の確認画面が出す件数（#436）。**書き込まない。**
 *
 * 2 段階確認の 1 段階目だけが呼ぶ——バッチ名を入力した直後に、対象の
 * 枚数を先に見せてから、本当に実行するかを retype させる
 * （`DelegatedCountBatchIssuedCardsUseCase` と対称。
 * `DelegatedReinstateBatchToIssuedCardsUseCase` の冒頭を参照）。
 */
export class DelegatedCountDisabledInBatchUseCase {
  constructor(private readonly cards: CardRepository) {}

  async execute(
    input: DelegatedCountDisabledInBatchInput,
  ): Promise<NfcOutcome<{ readonly count: number }>> {
    const count = await this.cards.countDisabledInBatch(input.batch);
    return outcomeOk({ count });
  }
}
