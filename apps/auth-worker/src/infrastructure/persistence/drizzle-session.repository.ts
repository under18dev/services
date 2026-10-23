import { type IdentityDatabase, sessions } from "@u18/db";
import { and, eq, isNull } from "drizzle-orm";
import type {
  CreateSessionInput,
  SessionRepository,
} from "../../application/ports/session.repository";
import { Session, type SessionProps } from "../../domain/entities/session";

type SessionRow = typeof sessions.$inferSelect;

function toDomain(row: SessionRow): Session {
  const props: SessionProps = {
    id: row.id,
    userId: row.userId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    authMethod: row.authMethod,
    lastSeenAt: row.lastSeenAt,
    userAgent: row.userAgent,
    ipHash: row.ipHash,
    createdAt: row.createdAt,
  };
  return Session.fromPersistence(props);
}

export class DrizzleSessionRepository implements SessionRepository {
  constructor(private readonly db: IdentityDatabase) {}

  async findByTokenHash(tokenHash: string): Promise<Session | null> {
    const row = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .get();
    return row ? toDomain(row) : null;
  }

  async findById(id: string): Promise<Session | null> {
    const row = await this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    return row ? toDomain(row) : null;
  }

  async listByUserId(userId: string): Promise<readonly Session[]> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.userId, userId)).all();
    return rows.map(toDomain);
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const now = new Date();
    const row = await this.db
      .insert(sessions)
      .values({
        id: input.id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        authMethod: input.authMethod,
        lastSeenAt: now,
        userAgent: input.userAgent,
        ipHash: input.ipHash,
      })
      .returning()
      .get();
    return toDomain(row);
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.db.update(sessions).set({ lastSeenAt: at }).where(eq(sessions.id, id)).run();
  }

  async revoke(id: string, at: Date): Promise<boolean> {
    // `revoked_at IS NULL` を条件に入れることで、同時に 2 回失効要求が来ても
    // 片方だけが行を更新する。二重失効で時刻が上書きされるのを防ぐ。
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: at })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id })
      .all();
    return rows.length > 0;
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: at })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id })
      .all();
    return rows.length;
  }
}
