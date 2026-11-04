import type { CardRepository, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";

export type DelegatedTransferCountDistributionOutput = {
  readonly zero: number;
  readonly one: number;
  readonly two: number;
  readonly threeOrMore: number;
};

/**
 * `transferCount` の分布（#454「⑥持ち主が変わり続けるカード」）。
 * 3 回以上は 1 つに束ねる——理由は `CardRepository.transferCountDistribution`
 * の宣言を参照。
 */
export class DelegatedTransferCountDistributionUseCase {
  constructor(private readonly cards: CardRepository) {}

  async execute(): Promise<NfcOutcome<DelegatedTransferCountDistributionOutput>> {
    const buckets = await this.cards.transferCountDistribution();
    return outcomeOk(buckets);
  }
}
