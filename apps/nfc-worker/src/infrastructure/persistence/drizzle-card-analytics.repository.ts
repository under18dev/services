import { type NfcDatabase, nfcCardTaps, nfcCards } from "@u18/nfc-db";
import { asc, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { CardAnalyticsRepository } from "../../application/ports";
import type { CardStatus } from "../../domain/entities/card";

/**
 * `nfc_cards` と `nfc_card_taps` をまたぐ集計の Drizzle 実装（#454）。
 * 設計意図は `CardAnalyticsRepository`（`application/ports.ts`）の冒頭を
 * 参照——ここだけが両方のテーブルを JOIN する。
 */
export class DrizzleCardAnalyticsRepository implements CardAnalyticsRepository {
  constructor(private readonly db: NfcDatabase) {}

  async batchAnalytics(
    sevenDaysAgo: string,
  ): ReturnType<CardAnalyticsRepository["batchAnalytics"]> {
    const cardRows = await this.db
      .select({
        batch: nfcCards.batch,
        issued: sql<number>`count(*)`,
        claimedEver: sql<number>`sum(case when ${nfcCards.claimedAt} is not null then 1 else 0 end)`,
        disabled: sql<number>`sum(case when ${nfcCards.status} = 'disabled' then 1 else 0 end)`,
      })
      .from(nfcCards)
      .groupBy(nfcCards.batch)
      .all();

    const allTimeRows = await this.db
      .select({ batch: nfcCards.batch, total: sql<number>`sum(${nfcCardTaps.count})` })
      .from(nfcCardTaps)
      .innerJoin(nfcCards, eq(nfcCards.id, nfcCardTaps.cardId))
      .groupBy(nfcCards.batch)
      .all();

    const last7dRows = await this.db
      .select({ batch: nfcCards.batch, total: sql<number>`sum(${nfcCardTaps.count})` })
      .from(nfcCardTaps)
      .innerJoin(nfcCards, eq(nfcCards.id, nfcCardTaps.cardId))
      .where(gte(nfcCardTaps.date, sevenDaysAgo))
      .groupBy(nfcCards.batch)
      .all();

    // **`batch` は null になりうる**（バッチ名無しで発行されたカード）。
    // `Map` のキーとして null をそのまま使う——`""` に潰すと「バッチ名が
    // 空文字のカード」と区別が付かなくなる。
    const allTimeByBatch = new Map(allTimeRows.map((row) => [row.batch, Number(row.total)]));
    const last7dByBatch = new Map(last7dRows.map((row) => [row.batch, Number(row.total)]));

    return cardRows.map((row) => ({
      batch: row.batch,
      issued: Number(row.issued),
      claimedEver: Number(row.claimedEver),
      disabled: Number(row.disabled),
      tapsAllTime: allTimeByBatch.get(row.batch) ?? 0,
      tapsLast7d: last7dByBatch.get(row.batch) ?? 0,
    }));
  }

  async rankedTaps(limit: number): ReturnType<CardAnalyticsRepository["rankedTaps"]> {
    const rows = await this.db
      .select({
        cardId: nfcCards.id,
        batch: nfcCards.batch,
        status: nfcCards.status,
        total: sql<number>`sum(${nfcCardTaps.count})`,
      })
      .from(nfcCardTaps)
      .innerJoin(nfcCards, eq(nfcCards.id, nfcCardTaps.cardId))
      .groupBy(nfcCards.id)
      .orderBy(desc(sql`sum(${nfcCardTaps.count})`))
      .limit(limit)
      .all();

    return rows.map((row) => ({
      cardId: row.cardId,
      batch: row.batch,
      status: row.status as CardStatus,
      total: Number(row.total),
    }));
  }

  async dormantClaimedCards(
    limit: number,
  ): ReturnType<CardAnalyticsRepository["dormantClaimedCards"]> {
    // **`left join` + `having sum(...) = 0`。** `coalesce` で「タップ行が
    // 1 つも無い」場合も 0 として扱う——`inner join` にすると、タップが
    // 1 件も無いカードは最初から結果に出てこない（見たいのはまさにそれ）。
    const countRows = await this.db
      .select({ cardId: nfcCards.id })
      .from(nfcCards)
      .leftJoin(nfcCardTaps, eq(nfcCardTaps.cardId, nfcCards.id))
      .where(isNotNull(nfcCards.claimedAt))
      .groupBy(nfcCards.id)
      .having(sql`coalesce(sum(${nfcCardTaps.count}), 0) = 0`)
      .all();

    const rows = await this.db
      .select({
        cardId: nfcCards.id,
        batch: nfcCards.batch,
        claimedAt: nfcCards.claimedAt,
        status: nfcCards.status,
      })
      .from(nfcCards)
      .leftJoin(nfcCardTaps, eq(nfcCardTaps.cardId, nfcCards.id))
      .where(isNotNull(nfcCards.claimedAt))
      .groupBy(nfcCards.id)
      .having(sql`coalesce(sum(${nfcCardTaps.count}), 0) = 0`)
      .orderBy(asc(nfcCards.claimedAt))
      .limit(limit)
      .all();

    return {
      count: countRows.length,
      rows: rows.map((row) => ({
        cardId: row.cardId,
        batch: row.batch,
        // `claimedAt` は WHERE 句で is not null を要求しているので非 null。
        claimedAt: row.claimedAt as Date,
        status: row.status as CardStatus,
      })),
    };
  }
}
