import { NfcRetention } from "../../domain/services/retention-policy";
import type { CardRepository, CardTapRecorder, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";

export type DelegatedUsageFunnelOutput = {
  /** 発行された全カードの枚数。`status` を問わない。 */
  readonly issued: number;
  /** 一度でも紐づいたことがある枚数（いま `disabled` でも含む）。 */
  readonly claimedEver: number;
  /** `nfc_card_taps` に現存する行から、1 回以上タップされたカードの枚数。
   *  保持期間（`retentionDays`）より前のタップは数に入らない。 */
  readonly tappedEver: number;
  readonly retentionDays: number;
};

/**
 * 発行 → 引き取り → 使用のファネル（#454「②ファネル」）。
 *
 * **各段は「通過したことがあるか」で、「いまその状態か」ではない。**
 * ファネルは前の段へ戻らない——`active` だったカードが後から
 * 無効化されても、「引き取られた」という事実は消えない
 * （`CardRepository.countClaimedEver` の宣言を参照）。
 *
 * `tappedEver` は保持期間の外のタップを数えられない。画面はこの段を
 * 「直近 {retentionDays} 日でタップされた」と明記すること——「使われた
 * ことがある」と書くと、保持期間より前に 1 回だけタップされて以降
 * 触られていないカードを見落とす（#454 の指示）。
 */
export class DelegatedUsageFunnelUseCase {
  constructor(
    private readonly cards: CardRepository,
    private readonly cardTaps: CardTapRecorder,
  ) {}

  async execute(): Promise<NfcOutcome<DelegatedUsageFunnelOutput>> {
    const [issued, claimedEver, tappedEver] = await Promise.all([
      this.cards.countTotal(),
      this.cards.countClaimedEver(),
      this.cardTaps.countDistinctWithTaps(),
    ]);

    return outcomeOk({
      issued,
      claimedEver,
      tappedEver,
      retentionDays: NfcRetention.standard / (24 * 60 * 60 * 1000),
    });
  }
}
