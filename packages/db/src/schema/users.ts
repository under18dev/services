import { relations, sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, timestampMs, updatedAt } from "./_shared";

/**
 * ユーザー本体。
 *
 * `id` は不変の内部識別子で、OIDC の `sub` にそのまま使う。email / username は
 * 変更されうるので認証の主キーにしない（仕様書 6.2）。
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    /**
     * 連絡先として「現在有効な」メールアドレス。正本は user_emails 側で、
     * ここは参照の利便のために非正規化して持つ。
     */
    primaryEmail: text("primary_email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["active", "suspended", "deleted"] })
      .notNull()
      .default("active"),
    /**
     * 論理削除の時刻。削除済みユーザーの行は即時に物理削除せず、
     * 監査ログとの整合と誤削除からの復旧のために保持期間を置く（仕様書 7.3）。
     */
    deletedAt: timestampMs("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // username / email は大文字小文字を無視して一意にする。
    uniqueIndex("users_username_unique").on(sql`lower(${table.username})`),
    // **この一意制約は無条件のまま維持すること（#62 / #51）。**
    //
    // 下の user_emails_email_unique は「確認済みの行だけ」に絞った部分
    // インデックスで、他人が未確認で占有して本来の持ち主を締め出す
    // 事前登録ロックアウトを防ぐためにそうなっている（#54 / #60）。
    // 形が違うので「揃えるべき食い違い」に見えるが、揃えてはならない。
    //
    // 仕様書 §14.1 決定 7 により、アカウントは物理削除せず凍結で表現する。
    // つまり凍結・BAN されたアカウントの行は残り続ける。ここを部分
    // インデックスに変えると、**凍結したアカウントのアドレスで新規登録
    // できてしまい、BAN が意味を失う。**
    //
    // 代償として、あるアドレスが既存アカウントの primary_email である限り
    // （未確認であっても）別アカウントは作れない。現在の signup 経路は
    // emailVerified: true でユーザーを作るのでこの窓は開いていないが、
    // 将来「未確認のまま仮登録する」経路を足すと表面化する。
    uniqueIndex("users_primary_email_unique").on(sql`lower(${table.primaryEmail})`),
    index("users_status_idx").on(table.status),
  ],
);

/**
 * メールアドレスと確認状態。
 *
 * 将来の「メール変更」「複数登録」に対応するため users から分離する（仕様書 7.1）。
 */
export const userEmails = sqliteTable(
  "user_emails",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    verifiedAt: timestampMs("verified_at"),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // 同じアドレスを複数アカウントが「確認済み」として持てないようにする。
    //
    // 一意性を verified_at が立った行だけに限るのが肝。無条件にすると、
    // 確認を完了しないサインアップが他人のアドレスを占有でき、本来の
    // 持ち主が登録できなくなる（所有を誰も証明していない行との衝突）。
    // 未確認行は重複を許し、確認完了時に初めてこの索引で弾く。
    uniqueIndex("user_emails_email_unique")
      .on(sql`lower(${table.email})`)
      .where(sql`${table.verifiedAt} is not null`),
    index("user_emails_user_idx").on(table.userId),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  emails: many(userEmails),
}));

export const userEmailsRelations = relations(userEmails, ({ one }) => ({
  user: one(users, { fields: [userEmails.userId], references: [users.id] }),
}));
