import { isoDateUtc, NfcRetention } from "../../domain/services/retention-policy";
import type { CardRepository, CardTapRecorder, Clock, NfcOutcome } from "../ports";
import { outcomeErr, outcomeOk } from "../ports";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type DelegatedCardTapHistoryInput = {
  /** 画面が選べる 3 択。既定・不正値のフォールバックは admin-worker 側。 */
  readonly days: 30 | 90 | 180;
  readonly cardId: string;
};

export type CardTapPeriodComparison = {
  readonly total: number;
  readonly previousTotal: number;
};

export type DelegatedCardTapHistoryOutput = {
  /** `days` 件、古い日から新しい日の順。タップが無い日も `0` で埋まる。 */
  readonly dailyTotals: readonly { readonly date: string; readonly total: number }[];
  /** 表示した期間（`days` 日ぶん）の合計。 */
  readonly totalTaps: number;
  readonly retentionDays: number;
  readonly lastTappedAt: string | null;
  readonly daysSinceLastTap: number | null;
  readonly last7d: CardTapPeriodComparison;
  readonly last30d: CardTapPeriodComparison;
};

/**
 * カード 1 枚のタップ履歴（#472）。
 *
 * ## 時間帯（0-23 時）別は作らない
 *
 * 一度はその形で設計しかけた。やらない理由は 3 つ（3b のレビュー）。
 *
 * 1. **`nfc_card_taps` が日次集計なのは意図した設計で、偶然ではない。**
 *    1 タップ 1 行のイベントログを避けるためにこの形にしてある
 *    （`packages/nfc-db/src/schema/taps.ts` の冒頭）。管理画面 1 枚の
 *    見栄えのために、その線引きを動かす取引ではない。
 * 2. **過去の行には時刻が付かない。** 今日から列を足しても、保持期間
 *    （180 日）が経つまでは「ある日より前は空」のグラフになる。
 *    **穴の空いたグラフは、無いグラフより誤読される。**
 * 3. **1 枚のカードは 1 人の持ち物である。** 全カードを合計した解析
 *    （#454 の `tapTimeseries` 等）の時間帯別ならまだ議論の余地があるが、
 *    **カード 1 枚について「何時台に多いか」は、その人の生活パターン
 *    そのものになる**（「平日 7:40 台に多い」＝通学時間）。
 *
 * ## 代わりに置くもの
 *
 * いまのスキーマだけで作れる値——直近 7 日・30 日と、その直前の同じ長さの
 * 期間との比較、最終タップからの経過日数。「増えているか減っているか」
 * 「いま動いているか」のほうが、生の日別グラフより先に知りたい、という
 * 判断（3b のレビュー）。
 *
 * ## 比較の窓は `days` と独立に 60 日で取る
 *
 * 30 日/30 日の比較には最大 60 日ぶんのデータが要る。`days=30` を選んで
 * いても、比較のためにそれより広く取る——`days` はグラフの見える幅を
 * 決めるだけで、比較の正しさに影響させない。
 *
 * ## 最終タップは `summaryFor` から取る（`cardDailyTotals` の窓からではない）
 *
 * `cardDailyTotals` は比較に要る分だけ（最大でも `max(days, 60)` 日）しか
 * 取らない。**実際の最終タップがそれより古ければ、窓の中には現れない。**
 * `summaryFor` は窓を持たない集計（保持期間の範囲でカード全体を見る）
 * なので、ここだけは別に引く。
 */
export class DelegatedCardTapHistoryUseCase {
  constructor(
    private readonly cards: CardRepository,
    private readonly cardTaps: CardTapRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: DelegatedCardTapHistoryInput,
  ): Promise<NfcOutcome<DelegatedCardTapHistoryOutput>> {
    const card = await this.cards.findById(input.cardId);
    if (card === null) return outcomeErr({ kind: "card_not_found" });

    const now = this.clock.now();
    const fetchDays = Math.max(input.days, 60);
    const sinceDate = isoDateUtc(new Date(now.getTime() - (fetchDays - 1) * MS_PER_DAY));

    const [rows, summary] = await Promise.all([
      this.cardTaps.cardDailyTotals(input.cardId, sinceDate),
      this.cardTaps.summaryFor(input.cardId),
    ]);
    const totalsByDate = new Map(rows.map((row) => [row.date, row.total]));

    const totalFor = (offsetStart: number, offsetEndInclusive: number): number => {
      let sum = 0;
      for (let i = offsetStart; i <= offsetEndInclusive; i++) {
        const date = isoDateUtc(new Date(now.getTime() - i * MS_PER_DAY));
        sum += totalsByDate.get(date) ?? 0;
      }
      return sum;
    };

    const dailyTotals: { date: string; total: number }[] = [];
    for (let i = input.days - 1; i >= 0; i--) {
      const date = isoDateUtc(new Date(now.getTime() - i * MS_PER_DAY));
      dailyTotals.push({ date, total: totalsByDate.get(date) ?? 0 });
    }

    const lastTappedAt = summary?.lastTappedAt ?? null;
    const daysSinceLastTap =
      lastTappedAt === null
        ? null
        : Math.round(
            (now.getTime() - new Date(`${lastTappedAt}T00:00:00Z`).getTime()) / MS_PER_DAY,
          );

    return outcomeOk({
      dailyTotals,
      totalTaps: dailyTotals.reduce((sum, day) => sum + day.total, 0),
      retentionDays: NfcRetention.standard / MS_PER_DAY,
      lastTappedAt,
      daysSinceLastTap,
      last7d: { total: totalFor(0, 6), previousTotal: totalFor(7, 13) },
      last30d: { total: totalFor(0, 29), previousTotal: totalFor(30, 59) },
    });
  }
}
