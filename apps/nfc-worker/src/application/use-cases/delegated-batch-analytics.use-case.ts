import { isoDateUtc } from "../../domain/services/retention-policy";
import type { CardAnalyticsRepository, Clock, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";

export type DelegatedBatchAnalyticsOutput = {
  readonly rows: readonly {
    /** バッチ名の無いカードは `null`。「バッチ名なし」の 1 行として
     *  画面に出すこと——落とすと `rows` の発行枚数の合計が
     *  `usageFunnel().issued` と合わなくなる（#454 の指示）。 */
    readonly batch: string | null;
    readonly issued: number;
    readonly claimedEver: number;
    readonly disabled: number;
    readonly tapsAllTime: number;
    readonly tapsLast7d: number;
  }[];
};

/**
 * バッチ単位の集計（#454「③バッチ別」）。
 *
 * **配布ロットが運用の単位**なので、押し間違いの被害範囲や、配った束ごと
 * の引き取り率を見るのにいちばん効く——issue の運用者コメントを参照。
 */
export class DelegatedBatchAnalyticsUseCase {
  constructor(
    private readonly analytics: CardAnalyticsRepository,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<NfcOutcome<DelegatedBatchAnalyticsOutput>> {
    const sevenDaysAgo = isoDateUtc(new Date(this.clock.now().getTime() - 7 * 24 * 60 * 60 * 1000));
    const rows = await this.analytics.batchAnalytics(sevenDaysAgo);
    return outcomeOk({ rows });
  }
}
