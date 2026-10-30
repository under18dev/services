import type { CardRepository, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";

export type DelegatedCountBatchIssuedCardsInput = {
  readonly batch: string;
};

/**
 * batch 一括無効化の確認画面が出す件数（#427）。**書き込まない。**
 *
 * 2 段階確認の 1 段階目だけが呼ぶ——バッチ名を入力した直後に、対象の
 * 枚数を先に見せてから、本当に実行するかを retype させる
 * （`DelegatedBatchDisableCardsUseCase` の冒頭を参照）。
 */
export class DelegatedCountBatchIssuedCardsUseCase {
  constructor(private readonly cards: CardRepository) {}

  async execute(
    input: DelegatedCountBatchIssuedCardsInput,
  ): Promise<NfcOutcome<{ readonly count: number }>> {
    const count = await this.cards.countIssuedInBatch(input.batch);
    return outcomeOk({ count });
  }
}
