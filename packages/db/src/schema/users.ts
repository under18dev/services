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
     * 連絡先として「現在有効な」メールアドレス。**一意性の正本はこの列である。**
     *
     * 設計当初は `user_emails` を正本に据える想定だったが、仕様書 §14.1 決定 7
     * （アカウントは物理削除せず凍結で表現する）と両立しない。正本であるなら
     * 自分で占有を裁けなければならないのに、`user_emails_email_unique` は
     * **確認済みの行だけ**に効く部分インデックスなので、未確認のまま凍結された
     * アカウントのアドレスを解放してしまう。占有を無条件に裁けるのは
     * `users_primary_email_unique` だけなので、一意性と `findByEmail()` の
     * 引き当てはこの列に置いたままにする（#96 / #62 / #51、仕様書 7.1）。
     *
     * `user_emails` は「どのアドレスが、いつ確認されたか」の台帳として書かれる
     * （書き込み経路は #96 で追加した）。第一アドレスについてはこの列の写しで
     * あり、`DrizzleUserRepository` が D1 の batch で両方を同時に書く。写しが
     * 欠けると下の部分インデックスが守るべき行を見失うので、片方だけ書かない。
     */
    primaryEmail: text("primary_email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["active", "suspended", "deleted"] })
      .notNull()
      .default("active"),
    /**
     * 管理権限を持つか（仕様書 §14.1 決定 8 / #83 / #40）。
     *
     * **ロール列ではなく真偽値にした。** 仕様書 §1.2 で組織・チーム権限管理は
     * 非目標であり、この列が答えるべき問いは 1 つしかない ——
     * 「このアカウントに決定 8（管理者は Passkey 必須、メール OTP 単独では
     * ログインできない）を適用するか」。text の enum にすると、まだ誰も
     * 定義していない役割名を置ける箱ができ、「この役割は何ができるのか」を
     * 決める表が無いまま値だけが増える。役割が本当に必要になったときは、
     * 真偽値 1 本を読み替えるほうが、意味の決まっていない enum 値を
     * 後から解釈するより安い。
     *
     * **この列を立てる前に Passkey が 1 本以上あることを確かめること。**
     * 付与は `apps/auth-worker/scripts/admin-role.mjs` からのみ行い、その
     * UPDATE は `exists (select 1 from passkeys ...)` を条件に持つ
     * （`apps/auth-worker/src/infrastructure/persistence/admin-role.sql.ts`）。
     * 条件を外すと「権限はあるがログインできない管理者」が作れてしまう。
     */
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    /**
     * 論理削除の時刻。削除済みユーザーの行は即時に物理削除せず、
     * 監査ログとの整合と誤削除からの復旧のために保持期間を置く（仕様書 7.3）。
     */
    deletedAt: timestampMs("deleted_at"),
    /**
     * 最後に**ログインした**時刻（#286）。
     *
     * ## なぜ列が要るのか
     *
     * 保持期間は「最終利用から 1 年」に決まった（2026-10-28、ランブック
     * §11.7）。ところが**起点を判定できる場所が無かった** ——
     * `sessions.last_seen_at` は 30 日で掃除され、`audit_logs` の
     * `session.issue` は `standard` 区分で 180 日しか残らない。
     * **1 年前の利用は、どちらにももう無い。**
     *
     * ## なぜ「ログイン」なのか
     *
     * `sessions.last_seen_at` は**認証付き要求が届いたこと**を測っている
     * （`GetSessionUseCase` が成功のたびに `touch()` を予約する）。
     * セッション Cookie は `SameSite=Lax` なので、**他サイトからの
     * トップレベル遷移でも更新される。** 応答は攻撃者から読めず実害は
     * 無いが、**「本人が使った」の証拠としては本人の意思と結び付いて
     * いない。**
     *
     * ここは `IssueSessionUseCase` —— **実際にログインが成立した瞬間**
     * だけで更新する。運用者の言葉（「1 年進捗がなかったら消す」）に
     * 近いのはこちらである。
     *
     * ## NULL の意味
     *
     * **「この列が入る前から居る」か「一度もログインしていない」。**
     * 洗い出しの条件は `last_active_at < ?` なので、**NULL は拾われない。**
     * 消すか残すかの既定は「残す」に倒してある —— 判定できないものを
     * 消す側に倒すと、取り返しがつかない（§11.6 は元に戻せない）。
     *
     * ## 掃除の対象にしない
     *
     * `RetentionPolicy` はこの列を見ない。**1 年を越えて残ることが役割**で
     * あり、掃除すると起点そのものが消える（それが #286 の出発点だった）。
     */
    lastActiveAt: timestampMs("last_active_at"),
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
    //
    // #96 で `user_emails` に書き始めた後も、この非対称は解消していない。
    // 解消する代わりに**役割を分けた**: 新規アカウントがそのアドレスを
    // 取れるかを決めるのはこの索引だけで、user_emails 側の部分インデックスは
    // 「同じアドレスを 2 人が確認済みとして持てない」ことだけを見る。
    // create() の batch では users への INSERT が先に走るので、凍結アドレス
    // での再登録は user_emails の判定に到達せずここで落ちる。
    uniqueIndex("users_primary_email_unique").on(sql`lower(${table.primaryEmail})`),
    index("users_status_idx").on(table.status),
  ],
);

/**
 * メールアドレスと確認状態の台帳。
 *
 * 将来の「メール変更」「複数登録」に対応するため users から分離する（仕様書 7.1）。
 *
 * **一意性の正本ではない**（`users.primary_email` 側のコメントを参照）。ここが
 * 答えるのは「このユーザーのこのアドレスは、いつ確認されたか」であって、
 * 「このアドレスで新規登録できるか」ではない。2 つの問いを 1 つの索引に
 * 背負わせようとしたことが #62 のねじれの出所だった。
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
    //
    // `users_primary_email_unique` が無条件であることとの非対称は、#96 で
    // **意図して残すと決めた**。新規アカウントの占有判定はあちらが単独で担い、
    // ここは「確認済みの重複」だけを見る。両方へ書く
    // `DrizzleUserRepository.create()` では users 側の INSERT が先に走るので、
    // 「部分インデックスだから凍結アドレスが解放される」ことは起きない。
    //
    // 逆に、将来 primary 以外のアドレスを登録する経路を足すと、users 側を
    // 通さずにここへ行が入る。そのとき**他人の primary_email と同じアドレスを
    // 確認済みにできるか**は、相手の user_emails 行が確認済みで在るかだけで
    // 決まる。create() / markEmailVerified() が必ず写しを書くのはそのためで、
    // 写しを省いた瞬間ここが素通りして二重の所有者ができる。
    uniqueIndex("user_emails_email_unique")
      .on(sql`lower(${table.email})`)
      .where(sql`${table.verifiedAt} is not null`),
    // 同じユーザーが同じアドレスの行を複数持たないようにする。
    //
    // `markEmailVerified()` は「行があれば verified_at を立て、無ければ足す」
    // を 1 文の upsert で行う。その衝突先がこの索引である。索引が無いと
    // upsert を書けず「読んでから書く」2 文に分かれ、同時に走った確認が
    // 同じアドレスの行を 2 本作る。判定がユーザー単位なので、他人を締め出す
    // 事前登録ロックアウトは生まない。
    uniqueIndex("user_emails_user_email_unique").on(table.userId, sql`lower(${table.email})`),
    // 第一アドレスの写しはユーザーごとに 1 行だけ。
    //
    // `users.primary_email` が正本である以上、それを指す写しが 2 本あると
    // どちらが現在の値なのか行からは決められない。アドレス変更では古い行の
    // is_primary を落としてから新しい行を立てる（同じ batch 内で順に適用
    // されるので、この索引に引っ掛からない）。
    uniqueIndex("user_emails_user_primary_unique")
      .on(table.userId)
      .where(sql`${table.isPrimary} = 1`),
    index("user_emails_user_idx").on(table.userId),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  emails: many(userEmails),
}));

export const userEmailsRelations = relations(userEmails, ({ one }) => ({
  user: one(users, { fields: [userEmails.userId], references: [users.id] }),
}));
