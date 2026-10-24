import { type IdentityDatabase, users } from "@u18/db";
import { newUserId } from "@u18/domain";
import { and, eq, sql } from "drizzle-orm";
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

  async create(input: NewUser): Promise<User> {
    const row = await this.db
      .insert(users)
      .values({
        id: input.id || newUserId(),
        username: input.username,
        displayName: input.displayName,
        primaryEmail: input.email,
        emailVerified: input.emailVerified,
      })
      .returning()
      .get();
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

  async markEmailVerified(id: string, email: string): Promise<void> {
    await this.db
      .update(users)
      .set({ emailVerified: true, primaryEmail: email, updatedAt: new Date() })
      .where(eq(users.id, id))
      .run();
  }
}
