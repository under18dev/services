import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * カードごと・日ごとのタップ回数（#394）。
 *
 * ## 誰がタップしたかは持たない
 *
 * 運用者からの要望は「NFC の使用頻度を分析したい」であって、
 * 「誰が使ったか」ではない。カード ID と日付の複合キーに `count` を
 * 足すだけにしてあり、**1 タップ 1 行のイベントログにはしていない** ——
 * 行が残ると「いつタップされたか」の時系列がそのまま行動の記録になり、
 * 要望より強い記録になる（`nfc_card_events` が所有者の操作を記録するのと
 * 性質が違う。あちらは「誰が何をしたか」、こちらは「何回使われたか」だけ）。
 *
 * ## 数えるのは `resolvable` のときだけ
 *
 * `claimable`（未紐づけ）や存在しないカードへのアクセスは数えない。
 * 「使用された回数」という定義に忠実にするための線引きで、書き込みは
 * `redirect.routes.ts` が `disclosure.kind === "resolvable"` を見てから行う
 * ——このテーブル自体はその判断を知らない。
 *
 * ## 原子的な UPDATE
 *
 * `INSERT ... ON CONFLICT (card_id, date) DO UPDATE SET count = count + 1`
 * で書く（`infrastructure/persistence/drizzle-card-tap.recorder.ts`）。
 * `nfc_cards` の条件付き UPDATE と同じ理由で、同時に来た 2 つのタップが
 * 両方とも加算を反映できる。
 *
 * ## 保持期間は `standard`（180 日）をそのまま使う
 *
 * 新しいティアは作らない。日次の集計行で、個々の操作のような
 * 「誰が何をしたか」の記録ではないが、持ち続ける理由も無い
 * （`domain/services/retention-policy.ts` の `tapCountDeadline`）。
 *
 * ## `card_id` に外部キーを張らない
 *
 * `nfc_cards.ts` の `owner_user_id` と同じ理由で、D1 は同一 DB 内の
 * テーブル間でも実効的な権限分離をしないため張る意味が薄く、
 * カードが削除される経路も無い（無効化は行を残す）。
 */
export const nfcCardTaps = sqliteTable(
  "nfc_card_taps",
  {
    cardId: text("card_id").notNull(),
    /** UTC の日付文字列（`YYYY-MM-DD`）。時刻は持たない。 */
    date: text("date").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.cardId, table.date] })],
);
