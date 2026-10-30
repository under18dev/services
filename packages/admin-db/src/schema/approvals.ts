import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt } from "./_shared";

/**
 * 「誰が admin.under18.dev を使ってよいか」の記憶（運用者の判断、2026-10-30 夜）。
 *
 * ## u18 Identity は「誰か」しか答えない
 *
 * admin-worker は OIDC で u18 Identity にログインする、ただのクライアント
 * の 1 つである。**u18 Identity の D1 には、誰が管理画面を使ってよいかの
 * 情報を一切足さない。** その判断の記憶はここ（admin-worker 専用 D1）に
 * 閉じる——Identity 側の決定とは独立に、admin-worker が増える・無くなる
 * たびにここだけが変わる。
 *
 * ## 「承認待ち」は行の不在で表す
 *
 * 専用の「申請中」テーブルは持たない。**ログインできたが `sub` がここに
 * 無い人は、全員「承認待ち」**——申請という操作を要らないほうが単純で、
 * 誰がどのタイミングでログインを試したかは admin-worker の HTTP ログ
 * （Workers の `observability`）で足りる。
 */
export const adminApprovals = sqliteTable(
  "admin_approvals",
  {
    id: text("id").primaryKey(),

    /**
     * u18 Identity の ID Token に乗る `sub`。
     *
     * **外部キーを張れない。** 別の D1（u18 Identity）の行を指しており、
     * SQLite の ATTACH は D1 では公開されていない（`packages/nfc-db` の
     * `owner_user_id` と同じ制約）。Identity 側でユーザーが凍結・削除
     * されても、この D1 は教えてくれない——admin-worker 側で確かめる
     * 手段が増えるまで（RPC binding など）、**承認を剥奪するのは運用の
     * 手作業**になる。
     */
    sub: text("sub").notNull().unique(),

    /**
     * 他人を承認・剥奪してよいか（「最高権限」）。
     *
     * **真偽値 1 本。** 仕様書 §1.2 が組織・チーム権限管理を非目標として
     * いるのと同じ判断で、役割を割る理由が無い段階では割らない
     * （d5 の scope 設計のコメントと同じ考え方）。
     */
    isSuperApprover: integer("is_super_approver", { mode: "boolean" }).notNull().default(false),

    /** 承認した人の sub。**最初の 1 人（CLI でのブートストラップ）は null。** */
    approvedBySub: text("approved_by_sub"),

    createdAt: createdAt(),
  },
  // **追加の索引は置かない。** `sub` の `.unique()` が既に一意索引を
  // 作るので、同じ列への索引を 2 つ持つと書き込みのたびに両方を
  // 更新することになるだけで何も得をしない。
);

/**
 * 承認の増減の記録（監査ログ）。
 *
 * `apps/nfc-worker` の `nfc_card_events`、auth-worker の `audit_logs` と
 * 同じ形——**状態テーブルと追記専用の記録テーブルを分ける。**
 * 権限の増減は、後から「誰がいつ何をしたか」を辿れないと意味が無い
 * （`apps/auth-worker/scripts/admin-role.mjs` の `requireActor` と同じ理由）。
 */
export const adminApprovalEvents = sqliteTable(
  "admin_approval_events",
  {
    id: text("id").primaryKey(),
    /** 対象の sub。 */
    sub: text("sub").notNull(),
    /** 例: "ops.approval.granted" / "ops.approval.revoked" */
    event: text("event").notNull(),
    /**
     * 実行者。**u18 Identity の `sub` ではなく、CLI の `--actor` にそのまま
     * 渡した自由文字列である**（`apps/auth-worker/scripts/admin-role.mjs`
     * の `actor` と同じ約束——GitHub のハンドルで足りる）。承認の増減は
     * いまのところこの CLI でしか起きないので、常に値が入る。
     * メールアドレスや本名は入れないこと。
     */
    actor: text("actor").notNull(),
    /** 自由文の理由。個人情報は入れない（監査ログに個人情報を残さない、仕様書 7.1 と同じ方針）。 */
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (table) => [index("admin_approval_events_sub_idx").on(table.sub, table.createdAt)],
);
