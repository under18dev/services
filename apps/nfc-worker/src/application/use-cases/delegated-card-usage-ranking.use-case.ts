import type { CardAnalyticsRepository, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";
import type { CardStatus } from "../../domain/entities/card";

export type DelegatedCardUsageRankingInput = {
  readonly limit: number;
};

export type DelegatedCardUsageRankingOutput = {
  readonly ranking: readonly {
    readonly cardId: string;
    readonly batch: string | null;
    readonly status: CardStatus;
    readonly total: number;
  }[];
  readonly dormant: {
    /** 正確な件数（`rows` の件数ではない——`rows` は先頭 `limit` 件だけ）。 */
    readonly count: number;
    readonly rows: readonly {
      readonly cardId: string;
      readonly batch: string | null;
      readonly claimedAt: string;
      readonly status: CardStatus;
    }[];
  };
};

/**
 * カード別ランキングと死蔵の検出（#454「④」）。
 *
 * **`ownerUserId` を返さない。** `rankedTaps` / `dormantClaimedCards`
 * （`CardAnalyticsRepository`）がそもそも持っていない値——運用者の指摘で、
 * ランキングから所有者へ辿れると実質「この人が何回使ったか」の画面に
 * なるため（#394 の設計意思）。カード自体の操作は `/nfc` 側で行う。
 */
export class DelegatedCardUsageRankingUseCase {
  constructor(private readonly analytics: CardAnalyticsRepository) {}

  async execute(
    input: DelegatedCardUsageRankingInput,
  ): Promise<NfcOutcome<DelegatedCardUsageRankingOutput>> {
    const [ranking, dormant] = await Promise.all([
      this.analytics.rankedTaps(input.limit),
      this.analytics.dormantClaimedCards(input.limit),
    ]);

    return outcomeOk({
      ranking,
      dormant: {
        count: dormant.count,
        rows: dormant.rows.map((row) => ({
          cardId: row.cardId,
          batch: row.batch,
          claimedAt: row.claimedAt.toISOString(),
          status: row.status,
        })),
      },
    });
  }
}
