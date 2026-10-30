import { type IdentityDatabase, userEmails, users } from "@u18/db";
import { newId, newUserId } from "@u18/domain";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type {
  NewUser,
  UpdateProfileOutcome,
  UserRepository,
} from "../../application/ports/user.repository";
import { User, type UserProps } from "../../domain/entities/user";

type UserRow = typeof users.$inferSelect;

/**
 * 行から Domain Entity へ変換する。
 *
 * Drizzle のテーブル型をそのまま Domain で使い回さない（仕様書 7.2）。
 * 列の追加が Domain に漏れないよう、必要な分だけを明示的に写す。
 */
function toDomain(row: UserRow): User {
  const props: UserProps = {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.primaryEmail,
    emailVerified: row.emailVerified,
    status: row.status,
    isAdmin: row.isAdmin,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return User.fromPersistence(props);
}

export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: IdentityDatabase) {}

  async findById(id: string): Promise<User | null> {
    const row = await this.db.select().from(users).where(eq(users.id, id)).get();
    return row ? toDomain(row) : null;
  }

  /**
   * メールアドレスからユーザーを引く。
   *
   * `user_emails` ではなく `users.primary_email` を引く。一意性の正本がそちらに
   * ある以上、引き当ても同じ列で行わないと「索引が許した重複」をここで解決する
   * 羽目になる（#96 / 仕様書 7.1）。`user_emails` には未確認の重複行が並びうる
   * ので、台帳を引くなら「どの行を返すか」を先に決める必要がある。
   *
   * 結果として **「確認済みの別アドレス」ではログインできない。** 複数アドレスの
   * 登録経路がまだ無いので実害は出ていないが、足すときはこの制限が先に来る。
   */
  async findByEmail(email: string): Promise<User | null> {
    // 一意インデックスと同じく lower() で引き、インデックスを効かせる。
    const row = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.primaryEmail}) = lower(${email})`)
      .get();
    return row ? toDomain(row) : null;
  }

  async findByUsername(username: string): Promise<User | null> {
    const row = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = lower(${username})`)
      .get();
    return row ? toDomain(row) : null;
  }

  /**
   * ユーザーを作り、第一アドレスを `user_emails` へも載せる。
   *
   * 一意性の正本は `users.primary_email` 側に残す（schema users.ts）。ここで
   * `user_emails` にも書くのは、**確認状態の台帳を空にしないため**である。
   * `user_emails_email_unique` は「相手の確認済みの行」が在ることを前提に
   * 二重所有を弾くので、写しを書かない限りその判定は常に素通りする（#96）。
   *
   * 2 文を D1 の batch に入れるのは、batch が暗黙のトランザクションで走り、
   * **users だけ入って user_emails が落ちる中途半端な状態にならない**から。
   * 凍結アカウントのアドレスで再登録を試みた場合は 1 文目の
   * `users_primary_email_unique` がまず落ち、user_emails 側は適用されない
   * （`test/user-emails-write-path.test.ts` が実測で固定している）。
   */
  async create(input: NewUser): Promise<User> {
    const id = input.id || newUserId();
    const now = new Date();
    const [inserted] = await this.db.batch([
      this.db
        .insert(users)
        .values({
          id,
          username: input.username,
          displayName: input.displayName,
          primaryEmail: input.email,
          emailVerified: input.emailVerified,
        })
        .returning(),
      this.db.insert(userEmails).values({
        id: newId("uem"),
        userId: id,
        email: input.email,
        // 確認済みで作られたときだけ時刻を入れる。既定を「確認済み」にすると、
        // 所有を証明していない行が user_emails_email_unique を占有し、本来の
        // 持ち主を締め出す（#54 / #60 が塞いだ事前登録ロックアウトそのもの）。
        verifiedAt: input.emailVerified ? now : null,
        isPrimary: true,
      }),
    ]);

    const row = inserted[0];
    // batch は成功したのに行が返らない状況は想定していない。黙って
    // 空のユーザーを組み立てるより、ここで落ちたほうが原因に辿り着ける。
    if (row === undefined) throw new Error("failed to insert user");
    return toDomain(row);
  }

  async updateProfile(
    id: string,
    changes: { displayName?: string; username?: string },
  ): Promise<UpdateProfileOutcome> {
    // 空の更新で SQL エラーにならないよう、変更がなければ現状を返す。
    if (changes.displayName === undefined && changes.username === undefined) {
      const current = await this.findById(id);
      return current === null ? { kind: "not_found" } : { kind: "updated", user: current };
    }

    // username を変えるときは「他の行が同じ名前を持っていないこと」を
    // UPDATE 自身の条件に入れる。引いてから書く 2 文に分けると、その隙間に
    // 同じ名前の登録が入り込める。1 文にすれば一意索引と同じ瞬間に判定される。
    const notTaken =
      changes.username === undefined
        ? undefined
        : sql`not exists (select 1 from ${users} as other where lower(other.username) = lower(${changes.username}) and other.id <> ${id})`;

    const row = await this.db
      .update(users)
      .set({
        ...(changes.displayName !== undefined ? { displayName: changes.displayName } : {}),
        ...(changes.username !== undefined ? { username: changes.username } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, id), notTaken))
      .returning()
      .get();
    if (row) return { kind: "updated", user: toDomain(row) };

    // 行が返らない理由は「対象が居ない」か「名前が取られている」のどちらか。
    // 応答の意味が違うので、ここで引き直して区別する。失敗時にしか走らない。
    return (await this.findById(id)) === null ? { kind: "not_found" } : { kind: "username_taken" };
  }

  /**
   * アドレスの到達性が確認できたことを記録する。
   *
   * `users.email_verified` だけ立てると、確認済みかどうかを `user_emails` で
   * 判断する処理（メール変更・複数登録）からは未確認のまま見える。台帳側にも
   * 同じ事実を書かなければ、`user_emails_email_unique` が守るべき行が存在せず
   * 二重所有を弾けない（#96）。
   *
   * 3 文を batch に入れて順に適用する:
   *
   *  1. 他のアドレスが持っている primary の印を降ろす。`users.primary_email`
   *     が正本である以上、それを指す写しは 1 行だけでなければならない
   *     （`user_emails_user_primary_unique`）。2 文目より前に走る必要がある。
   *  2. 台帳に確認済みとして載せる。行の有無で INSERT / UPDATE を分けると
   *     「読んでから書く」になり、同時に走った確認が同じアドレスの行を 2 本
   *     作る。`user_emails_user_email_unique` を衝突先にした upsert 1 文に
   *     畳んで、索引と同じ瞬間に決着させる。
   *  3. `users` 側を更新する。
   *
   * 他人が既に同じアドレスを確認済みとして持っていれば 2 文目が
   * `user_emails_email_unique` で落ち、batch ごと巻き戻るので
   * `users.email_verified` も立たない。片方だけ確認済みになる状態を作らない。
   */
  async markEmailVerified(id: string, email: string): Promise<void> {
    const now = new Date();
    await this.db.batch([
      this.db
        .update(userEmails)
        .set({ isPrimary: false, updatedAt: now })
        .where(
          and(
            eq(userEmails.userId, id),
            eq(userEmails.isPrimary, true),
            sql`lower(${userEmails.email}) <> lower(${email})`,
          ),
        ),
      this.db
        .insert(userEmails)
        .values({ id: newId("uem"), userId: id, email, verifiedAt: now, isPrimary: true })
        .onConflictDoUpdate({
          target: [userEmails.userId, sql`lower(${userEmails.email})`],
          set: {
            // 初めて確認が取れた時刻を残す。再ログインのたびに上書きすると、
            // 「いつから確認済みか」が監査から読めなくなる。
            verifiedAt: sql`coalesce(${userEmails.verifiedAt}, ${now.getTime()})`,
            isPrimary: true,
            updatedAt: now,
          },
        }),
      this.db
        .update(users)
        .set({ emailVerified: true, primaryEmail: email, updatedAt: now })
        .where(eq(users.id, id)),
    ]);
  }

  /**
   * 最後にログインした時刻を記録する（#286）。
   *
   * **`updated_at` を進めない。** `_shared.ts` の `$onUpdateFn` は
   * 「その列が渡されていないとき」にだけ走るので、**現在値を明示して
   * 入れ直す。**
   *
   * ## 列ごとの例外ではなく、既にある規則に揃えている
   *
   * `users.updated_at` は内部の記録ではない —— **OIDC の標準クレーム**
   * として外へ出る（`User.toClaims()`）。意味は「End-User の情報が最後に
   * 更新された時刻」で、**RP はこれを見てプロフィールを取り直すかを
   * 決める。**
   *
   * 同じことを避ける決定が既にある:
   *
   *     // update-profile.use-case.ts
   *     // updatedAt を動かすと OIDC の `updated_at` claim が理由なく進み、
   *     // 監査ログにも「何も変わっていない変更」が積もる。
   *     if (changedFields.length === 0) return ok({ user, changedFields });
   *
   * **同じ値を送り直したときに書き込まないのは、このクレームを守るため**
   * である。ログインのたびに進めると、**プロフィールは何も変わって
   * いないのに RP が取り直す。** `update-profile` が正面から避けている
   * ものを、別の入口から入れることになる（指摘: 66）。
   *
   * ## いま実害は出ていない
   *
   * 本番に RP は 1 つも居ない（`oauth_grants` 0 件）。**だからこそ
   * 「使われていないから壊れていない」の棚に乗る** —— 最初の RP が
   * 繋がった日に動き出す。
   *
   * **2026-10-29 に本番で実際に起きた。** 初めてのログインで
   * `users.updated_at` が `last_active_at` と同じ時刻へ進んだ
   * （どちらも `12:46:26`）。プロフィールは何も変わっていない。
   */
  async touchLastActive(id: string, at: Date): Promise<void> {
    await this.db
      .update(users)
      // **`updatedAt` を明示して現在値を入れ直す。** `$onUpdateFn` は
      // 「その列が渡されていないとき」にだけ走るので、こう書くと動かない。
      // 生の SQL で書くより、列名を drizzle に解決させるほうが安全である
      // （SQLite の UPDATE は `set` 側に修飾付きの列名を許さない）。
      .set({ lastActiveAt: at, updatedAt: sql`${users.updatedAt}` })
      .where(eq(users.id, id))
      .run();
  }

  /**
   * 本人の退会（#318）。`active` の行だけを `suspended` にする。
   *
   * **`deleted` にしない。** 理由はポートのコメント（`purgeUserSql` の
   * ガードに弾かれ、管理者が個人情報を落とせなくなる）。
   *
   * **`active` に限る。** 既に `suspended`（BAN 済み）の相手を退会扱いで
   * 上書きすると、**BAN した事実が退会の記録で塗り替えられる。** 当たった
   * かどうかを返し、呼び出し側が二重実行を見分けられるようにする。
   */
  async closeAccount(id: string): Promise<boolean> {
    const result = await this.db
      .update(users)
      .set({ status: "suspended" })
      .where(and(eq(users.id, id), eq(users.status, "active")))
      .run();
    return result.meta.changes > 0;
  }

  /**
   * 管理者による停止・解除（#375）。
   *
   * **`status` の条件を WHERE に入れる。** 読んでから書くまでの隙間で
   * 状態が変われば 0 行になり、呼ぶ側が `conflict` を返せる。
   * `closeAccount` が `eq(users.status, "active")` を持つのと同じ形。
   *
   * **`deleted` はどちらの `from` にも当たらない。** 型で `"deleted"` を
   * 受け取らないので、ここに書き足さない限り当たりようがない。
   */
  async setStatus(
    id: string,
    change: { readonly from: "active" | "suspended"; readonly to: "active" | "suspended" },
  ): Promise<boolean> {
    const result = await this.db
      .update(users)
      .set({ status: change.to })
      .where(and(eq(users.id, id), eq(users.status, change.from)))
      .run();
    return result.meta.changes > 0;
  }

  /**
   * 管理画面の一覧（#375）。
   *
   * ## `OFFSET` を使わない
   *
   * `limit/offset` は「何ページ目か」で数えるので、**読んでいる最中に
   * 行が増えると同じ人が 2 回出たり、1 人飛ばされたりする。** 利用者は
   * いつでも登録できるので、この形は実際に起きる。最後に見た行より
   * 古いものを返す（キーセット）ほうが、途中で増えても並びが崩れない。
   *
   * ## 照合は完全一致だけ
   *
   * `query` はメールアドレスか username の完全一致で引く。
   * **`like` を使わない** —— `primary_email` と `username` の一意索引が
   * そのまま効き、全表走査にならない。アドレスは大文字小文字を無視する
   * （`findByEmail` と同じ扱い）。
   */
  async listForAdmin(criteria: {
    readonly query?: string;
    readonly after?: { readonly createdAt: Date; readonly id: string };
    readonly limit: number;
  }): Promise<readonly User[]> {
    const conditions = [];

    if (criteria.query !== undefined) {
      const normalized = criteria.query.trim();
      conditions.push(
        or(
          sql`lower(${users.primaryEmail}) = lower(${normalized})`,
          eq(users.username, normalized),
        ),
      );
    }

    if (criteria.after !== undefined) {
      // **`id` を混ぜる。** 同じミリ秒に作られた行が 2 つあると、
      // `created_at` だけではカーソルがそこで止まる（seed で実際に起きる）。
      const at = criteria.after.createdAt.getTime();
      conditions.push(
        or(
          lt(users.createdAt, criteria.after.createdAt),
          and(eq(users.createdAt, criteria.after.createdAt), lt(users.id, criteria.after.id)),
        ),
      );
      void at;
    }

    const rows = await this.db
      .select()
      .from(users)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(criteria.limit)
      .all();

    return rows.map(toDomain);
  }
}
