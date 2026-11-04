import { isoDateUtc, NfcRetention } from "../../domain/services/retention-policy";
import type { CardTapRecorder, Clock, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type DelegatedTapTimeseriesInput = {
  /** 画面が選べる 3 択。既定・不正値のフォールバックは admin-worker 側。 */
  readonly days: 30 | 90 | 180;
};

export type DelegatedTapTimeseriesOutput = {
  /** `days` 件、古い日から新しい日の順。タップが無い日も `0` で埋まる。 */
  readonly dailyTotals: readonly { readonly date: string; readonly total: number }[];
  readonly totalTaps: number;
  /** 小数第 1 位で丸めた 1 日あたりの平均。 */
  readonly dailyAverage: number;
  /** タップが 1 件も無ければ `null`。 */
  readonly maxDay: { readonly date: string; readonly total: number } | null;
  /** タップの保持期間（日数）。画面はこれを使って文言を組み、`180` を
   *  直書きしない——`NfcRetention.standard` が変われば自動で追従する。 */
  readonly retentionDays: number;
};

/**
 * タップの日次時系列（#454「①タップの時系列」）。
 *
 * ## 0 件の日を埋めるのはここの仕事
 *
 * `CardTapRecorder.dailyTotals` はタップがあった日の行しか返さない
 * （`nfc_card_taps` が疎なテーブルであるため）。グラフが棒の抜けを
 * 「データが無い」ではなく「0 件」として描けるよう、ここで `days` 日分の
 * 密な配列に埋め直す。
 *
 * ## 「全期間」と書かせない
 *
 * `retentionDays` を応答に含めることで、画面側が `180` を直書きせずに
 * 済む。180 日より前のタップは `ExpiredTapPurger` が消しているので、
 * `days=180` を選んでも「保持期間ぶん」であって「全期間」ではない
 * ——画面の文言はこの違いを明記すること（issue #454 の指示）。
 */
export class DelegatedTapTimeseriesUseCase {
  constructor(
    private readonly cardTaps: CardTapRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: DelegatedTapTimeseriesInput,
  ): Promise<NfcOutcome<DelegatedTapTimeseriesOutput>> {
    const now = this.clock.now();
    const sinceDate = isoDateUtc(new Date(now.getTime() - (input.days - 1) * MS_PER_DAY));

    const rows = await this.cardTaps.dailyTotals(sinceDate);
    const totalsByDate = new Map(rows.map((row) => [row.date, row.total]));

    const dailyTotals: { date: string; total: number }[] = [];
    for (let i = input.days - 1; i >= 0; i--) {
      const date = isoDateUtc(new Date(now.getTime() - i * MS_PER_DAY));
      dailyTotals.push({ date, total: totalsByDate.get(date) ?? 0 });
    }

    const totalTaps = dailyTotals.reduce((sum, day) => sum + day.total, 0);
    const dailyAverage = Math.round((totalTaps / input.days) * 10) / 10;
    const maxDay = dailyTotals.reduce<{ date: string; total: number } | null>(
      (max, day) => (max === null || day.total > max.total ? day : max),
      null,
    );

    return outcomeOk({
      dailyTotals,
      totalTaps,
      dailyAverage,
      maxDay: maxDay !== null && maxDay.total > 0 ? maxDay : null,
      retentionDays: NfcRetention.standard / MS_PER_DAY,
    });
  }
}
