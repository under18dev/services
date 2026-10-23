import { type IdentityDatabase, users } from "@u18/db";
import { newUserId } from "@u18/domain";
import { eq, sql } from "drizzle-orm";
import type { NewUser, UserRepository } from "../../application/ports/user.repository";
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
  ): Promise<User | null> {
    // 空の更新で SQL エラーにならないよう、変更がなければ現状を返す。
    if (changes.displayName === undefined && changes.username === undefined) {
      return this.findById(id);
    }
    const row = await this.db
      .update(users)
      .set({
        ...(changes.displayName !== undefined ? { displayName: changes.displayName } : {}),
        ...(changes.username !== undefined ? { username: changes.username } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning()
      .get();
    return row ? toDomain(row) : null;
  }

  async markEmailVerified(id: string, email: string): Promise<void> {
    await this.db
      .update(users)
      .set({ emailVerified: true, primaryEmail: email, updatedAt: new Date() })
      .where(eq(users.id, id))
      .run();
  }
}
