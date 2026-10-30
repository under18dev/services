import { sql } from "drizzle-orm";
import { nfcCardTaps, type NfcDatabase } from "@u18/nfc-db";
import type { ExpiredTapPurger } from "../../application/ports";

/**
 * 保持期限を過ぎたタップ集計行を消す（#394）。
 *
 * ## `nfc_card_taps` には `id` が無い
 *
 * `DrizzleExpiredEventPurger` は `where id in (select id ... limit ?)` の
 * 形で上限を付けているが、こちらは `(card_id, date)` の複合主キーしか
 * 持たない。`WITHOUT ROWID` を指定していない通常の SQLite テーブルは
 * 複合主キーがあっても暗黙の `rowid` を持つので、それで絞る
 * （D1 の既定ビルドは `DELETE ... LIMIT` を直接サポートしないため、
 * 同じ回避策が要る）。
 *
 * ## `date` は文字列比較で境界を取る
 *
 * `YYYY-MM-DD` 形式は辞書式順序と時系列順序が一致するので、
 * `date < deadline` がそのまま「境界より古い」になる。
 */
export class DrizzleExpiredTapPurger implements ExpiredTapPurger {
  constructor(private readonly db: NfcDatabase) {}

  async purge(deadline: string, limit: number): Promise<number> {
    const result = await this.db.run(sql`
      delete from ${nfcCardTaps}
      where rowid in (
        select rowid from ${nfcCardTaps} where ${nfcCardTaps.date} < ${deadline} limit ${limit}
      )
    `);
    return result.meta.changes;
  }
}
