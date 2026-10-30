import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, timestampMs, updatedAt } from "./_shared";

/**
 * 文化祭で配布する NFC カード（仕様書 10）。
 *
 * ## なぜ Identity D1 と同じテーブル空間に置かないのか
 *
 * 仕様書 3 は「NFC用データストアは将来的に別スキーマまたは別D1 DBへ
 * 分離可能とする」としているが、ここでは**最初から別 D1** にしている。
 *
 * 理由は分離の容易さではなく、binding の粒度にある。D1 binding には
 * 「このユーザーの行だけ」という粒度が無い（docs/architecture.md 1.1）。
 * NFC のテーブルを `u18-identity` に同居させると、nfc-worker に
 * そのテーブルを触らせるには `u18-identity` 全体の binding を渡すしかなく、
 * nfc-worker が侵害された時点で `sessions` と `oauth_tokens` が丸ごと読める。
 * 「NFC タグ自体をログイン資格情報にしない」（仕様書 10）という不変条件を
 * 守っても、カード管理 Worker が Identity DB を読めるなら意味が薄い。
 *
 * 同じ D1 の中で「別スキーマ」にする案は SQLite では成立しない。
 * SQLite のスキーマ分離は ATTACH された別ファイル単位であり、D1 はそれを
 * 公開していないので、同一 DB 内でテーブル名を分けても権限は分かれない。
 *
 * 代償として `owner_user_id` に外部キーを張れない。Identity 側でユーザーが
 * 凍結・削除されても DB は教えてくれないので、整合はアプリケーション側の
 * 責務になる（下の `owner_user_id` のコメントを参照）。
 */
export const nfcCards = sqliteTable(
  "nfc_cards",
  {
    /**
     * カード ID。`https://go.under18.dev/c/<id>` の `<id>` そのもの。
     *
     * **ユーザー ID から導出しない**（仕様書 10）。導出すると、カードを
     * 拾った人・タグを読んだ人が所有者の `sub` を手に入れることになり、
     * OIDC の `sub` を知っている相手にしか成立しない攻撃（ユーザー列挙、
     * 他サービスでの名寄せ）の入口になる。`nfc_` 接頭辞つきの
     * crypto 乱数由来の値を使い、Identity 側とは一切の関係を持たせない。
     *
     * **長さは 100 ビット**（`@u18/domain` の `newCardId()`）。短くすると、
     * タグを 1 枚持っている人間が隣の番号を試して他人のカードの遷移先を
     * 観測できる（列挙）。
     *
     * **#358 以降、この ID が唯一の秘密である。** 紐づけコードを廃止し、
     * 「タップしてログインした人のものになる」形にしたので、`issued` の
     * カードは **ID を知っていること自体が所有の主張になる**。
     * 長さをここに書くだけにせず `newCardId()` に持たせているのは、
     * **この文章が 100 と言いながら本番が 80 を作っていた**ためである（#358）。
     */
    id: text("id").primaryKey(),

    /**
     * 所有者の Identity userId。未紐づけなら null。
     *
     * 外部キーは張れない（別 D1）。したがって、ここに残った userId が
     * Identity 側で既に凍結・削除されている可能性が常にある。
     * 解決は「読むたびに Identity へ照会する」ではなく、
     * **変更操作のたびにセッションから得た userId と突き合わせる**ことで行う。
     * 凍結されたユーザーはセッションを発行できないので、変更操作には到達しない。
     *
     * リダイレクト解決（GET /c/:id）は所有者の生死を見ない。見に行くと
     * 1 タップごとに Identity へ RPC が飛び、NFC 側の障害が Identity の
     * 負荷になる。カードを止めたいときは `status` を倒す。
     */
    ownerUserId: text("owner_user_id"),

    /**
     * リダイレクト先。未設定なら null。
     *
     * `https:` のみを格納する。検証は書き込み側（domain/services/target-url.ts）で
     * 行い、ここには正規化済みの絶対 URL だけが入る。読み出し時にも
     * もう一度 scheme を確かめること —— DB を直接書き換えられた場合や、
     * 検証規則を後から厳しくした場合に、古い行がそのまま配信されるのを防ぐ。
     */
    targetUrl: text("target_url"),

    /**
     * カードの状態。
     *
     * - `issued`   発行済み・未紐づけ。紐づけを受け付ける。解決はしない。
     *              **#358 以降、この状態だけが外から区別できる** ——
     *              タップした人を紐づけ画面へ送るため（`domain/services/disclosure.ts`）。
     * - `active`   所有者あり。解決する。
     * - `disabled` 無効化（紛失・不正利用）。解決も紐づけも受け付けない。
     *
     * `disabled` からは所有者が自分で復帰できない。紛失したカードを
     * 拾った人間が「無効化されている」ことを手掛かりに持ち主を探す動機を
     * 与えないため、復帰は運用側（運営）の操作にする。
     *
     * **`disabled` は「存在しない」と区別が付かないままにすること。**
     * #358 で `issued` を区別するようにしたが、**それと一緒に緩めない** ——
     * 拾った人間に「このカードは止められている」と教えないことが、
     * 紛失対策の本体である。
     */
    status: text("status", { enum: ["issued", "active", "disabled"] })
      .notNull()
      .default("issued"),

    /** 現在の所有者が紐づけた時刻。未紐づけなら null。 */
    claimedAt: timestampMs("claimed_at"),

    /**
     * 所有者が変わった回数。
     *
     * 「このカードは自分のものだ」という主張が競合したときに、
     * 何回移転しているかが分かると調査の起点になる。
     */
    transferCount: integer("transfer_count").notNull().default(0),

    disabledAt: timestampMs("disabled_at"),
    /** 無効化の理由コード（自由文は入れない）。例: "lost", "abuse", "ops"。 */
    disabledReason: text("disabled_reason"),

    /**
     * 配布ロット。文化祭の「この束」を一括で失効させるための運用キー。
     *
     * 紛失が 1 枚ずつ報告されるとは限らない（配布前の箱ごと盗難など）。
     * カード ID が独立乱数なので範囲指定で止める術が無く、ロットを
     * 持たないと「全部止める」以外の選択肢が消える。
     */
    batch: text("batch"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // 「自分のカード一覧」のための索引。status も入れるのは、
    // 無効化済みを含めて一覧したいが既定では active を先に出すため。
    index("nfc_cards_owner_idx").on(table.ownerUserId, table.status),
    index("nfc_cards_batch_idx").on(table.batch),
  ],
);

/**
 * カードに起きたことの記録（仕様書 9 の監査ログに相当）。
 *
 * Identity の `audit_logs` とは別物。NFC 側の出来事を Identity D1 へ
 * 書きに行くと、nfc-worker に Identity への書き込み権限が要る
 * （仕様書 2.2 が禁じている）。
 *
 * **秘密を入れない。** 紐づけコード、セッショントークン、生 IP は書かない。
 * 目的は「誰が・いつ・何をしたか」を後から追えることであって、
 * 操作を再現できる材料を残すことではない。
 */
export const nfcCardEvents = sqliteTable(
  "nfc_card_events",
  {
    id: text("id").primaryKey(),
    cardId: text("card_id").notNull(),
    /**
     * 例: "card.issued" / "card.claimed" / "card.released" /
     *     "card.target_updated" / "card.disabled"
     */
    event: text("event").notNull(),
    /**
     * 操作した Identity userId。運営の操作や発行時は null。
     * ここも外部キーを張れないため、Identity 側の削除とは同期しない。
     */
    actorUserId: text("actor_user_id"),
    /**
     * 追加文脈の JSON。遷移先 URL など、所有者自身が設定した値は入れてよい。
     * 紐づけコードは入れない。
     */
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    index("nfc_card_events_card_idx").on(table.cardId, table.createdAt),
    index("nfc_card_events_actor_idx").on(table.actorUserId, table.createdAt),
  ],
);
