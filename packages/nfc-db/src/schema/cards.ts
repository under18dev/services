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
     * 長さは 100bit 相当を想定している。短くすると、タグを 1 枚持っている
     * 人間が隣の番号を試して他人のカードの遷移先を観測できる（列挙）。
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
     * - `issued`   発行済み・未紐づけ。claim を受け付ける。解決はしない。
     * - `active`   所有者あり。解決する。
     * - `disabled` 無効化（紛失・不正利用）。解決も claim も受け付けない。
     *
     * `disabled` からは所有者が自分で復帰できない。紛失したカードを
     * 拾った人間が「無効化されている」ことを手掛かりに持ち主を探す動機を
     * 与えないため、復帰は運用側（運営）の操作にする。
     */
    status: text("status", { enum: ["issued", "active", "disabled"] })
      .notNull()
      .default("issued"),

    /**
     * 紐づけコードのハッシュ（SHA-256 hex）。未発行・使用済みなら null。
     *
     * **カード ID と別の秘密であることが本質。** カード ID はタグを
     * かざした全員が読めるので、「カード ID を知っていること」を紐づけの
     * 根拠にすると、文化祭でカードを配る前にタグを読んだ人間が他人のカードを
     * 自分のアカウントへ結び付けられる。そこでカードには「タグに書かれない
     * 紐づけコード」（スクラッチ／封緘で配る）を別に添え、その所持を
     * 1 回だけ消費して所有者を確定する。
     *
     * 平文は保存しない（仕様書 7.1 と同じ扱い）。高エントロピーな乱数なので
     * ハッシュは SHA-256 で足りる（遅いハッシュは要らない）。
     */
    claimCodeHash: text("claim_code_hash"),

    /** 紐づけコードを発行した時刻。失効判定と、再発行の監査に使う。 */
    claimCodeIssuedAt: timestampMs("claim_code_issued_at"),

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
