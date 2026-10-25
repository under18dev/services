import { and, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { nfcCardEvents, type NfcDatabase } from "@u18/nfc-db";
import type { ExpiredEventPurger } from "../../application/ports";

/**
 * 保持期限を過ぎたカードイベントを消す（仕様書 §9 Privacy）。
 *
 * ## イベント名ごとに境界が違う
 *
 * `(event = ? and created_at < ?)` を OR で並べる。**`created_at` だけで
 * 切ってはいけない** —— 長期側（`card.claimed` / `card.released`）が
 * 短いほうの境界で巻き込まれ、カードの奪取を後から追えなくなる。
 * しかも SQL は成功し、件数も自然に見えるので気づけない。
 *
 * 索引は `(card_id, created_at)` と `(actor_user_id, created_at)` の 2 本で、
 * **`event` の索引は無い。** 行数が少ないうちは問題にならないが、
 * 掃除が重くなったらここが最初に疑う場所になる。
 *
 * ## 上限を外さない
 *
 * `delete ... limit` は SQLite の既定ビルドで使えないので、
 * `where id in (select id ... limit ?)` の形にする（Identity 側の
 * `DrizzleExpiredRecordPurger` と同じ）。
 */
export class DrizzleExpiredEventPurger implements ExpiredEventPurger {
  constructor(private readonly db: NfcDatabase) {}

  async purge(deadlines: ReadonlyMap<string, Date>, limit: number): Promise<number> {
    // 境界が 1 つも無いなら何もしない。全件消すほうへ倒さないこと。
    if (deadlines.size === 0) return 0;

    const conditions: SQL[] = [];
    for (const [event, deadBefore] of deadlines) {
      const condition = and(
        eq(nfcCardEvents.event, event),
        lt(nfcCardEvents.createdAt, deadBefore),
      );
      if (condition !== undefined) conditions.push(condition);
    }

    const doomed = this.db
      .select({ id: nfcCardEvents.id })
      .from(nfcCardEvents)
      .where(or(...conditions))
      .limit(limit);

    const result = await this.db
      .delete(nfcCardEvents)
      .where(inArray(nfcCardEvents.id, doomed))
      .run();
    return result.meta.changes;
  }
}
