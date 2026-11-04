import type { CardRepository, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";

export type DelegatedDisabledReasonBreakdownOutput = {
  readonly rows: readonly { readonly reason: string | null; readonly count: number }[];
};

/**
 * `disabled_reason` 別の内訳（#454「⑤無効化の内訳」）。
 *
 * **出てきた値をそのまま返す。** 語彙がまだ揃っていないことは既知
 * （`DelegatedBatchDisableCardsUseCase` の冒頭の表を参照）なので、ここで
 * 正規化・翻訳はしない——未知の値を落とすと「数が合わない」事故になる。
 * 翻訳・並び替えは画面側（admin-worker）の責務。
 */
export class DelegatedDisabledReasonBreakdownUseCase {
  constructor(private readonly cards: CardRepository) {}

  async execute(): Promise<NfcOutcome<DelegatedDisabledReasonBreakdownOutput>> {
    const rows = await this.cards.disabledReasonBreakdown();
    return outcomeOk({ rows });
  }
}
