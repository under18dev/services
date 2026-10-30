import { inArray, sql } from "drizzle-orm";
import { nfcCardTaps, type NfcDatabase } from "@u18/nfc-db";
import type { CardTapRecorder } from "../../application/ports";

/**
 * カードのタップ回数の Drizzle 実装（#394）。
 *
 * `DrizzleCardEventRecorder` と同じく、書き込みの失敗を自分で飲み込む。
 * 呼び出し元の `redirect.routes.ts` は `executionCtx.waitUntil` へ
 * 載せるだけで、応答が返ったあとにここが失敗しても誰も拾わない
 * ——「カードが壊れた」ように見せないため、ここで止める。
 */
export class DrizzleCardTapRecorder implements CardTapRecorder {
  constructor(private readonly db: NfcDatabase) {}

  async recordTap(cardId: string, date: string): Promise<void> {
    try {
      await this.db
        .insert(nfcCardTaps)
        .values({ cardId, date, count: 1 })
        .onConflictDoUpdate({
          target: [nfcCardTaps.cardId, nfcCardTaps.date],
          set: { count: sql`${nfcCardTaps.count} + 1` },
        })
        .run();
    } catch (cause) {
      // cardId はログに出す（存在と回数しか持たないテーブルで、
      // 所有者にも操作にも繋がらない）。日付は境界調査に要る。
      console.error(JSON.stringify({ event: "nfc.tap_count.write_failed", cardId, date }), cause);
    }
  }

  async totalsFor(cardIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (cardIds.length === 0) return new Map();

    const rows = await this.db
      .select({ cardId: nfcCardTaps.cardId, total: sql<number>`sum(${nfcCardTaps.count})` })
      .from(nfcCardTaps)
      .where(inArray(nfcCardTaps.cardId, cardIds))
      .groupBy(nfcCardTaps.cardId)
      .all();

    return new Map(rows.map((row) => [row.cardId, Number(row.total)]));
  }
}
