import { emailChallenges, type IdentityDatabase } from "@u18/db";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type {
  ConsumeResult,
  CreateEmailChallengeInput,
  EmailChallenge,
  EmailChallengeRepository,
  OtpPurpose,
} from "../../application/ports/email-challenge.repository";

type Row = typeof emailChallenges.$inferSelect;

function toDomain(row: Row): EmailChallenge {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    purpose: row.purpose,
    expiresAt: row.expiresAt,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    consumedAt: row.consumedAt,
    lastSentAt: row.lastSentAt,
    createdAt: row.createdAt,
  };
}

export class DrizzleEmailChallengeRepository implements EmailChallengeRepository {
  constructor(private readonly db: IdentityDatabase) {}

  async create(input: CreateEmailChallengeInput): Promise<EmailChallenge> {
    const row = await this.db
      .insert(emailChallenges)
      .values({
        id: input.id,
        userId: input.userId,
        email: input.email,
        codeHash: input.codeHash,
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        maxAttempts: input.maxAttempts,
        lastSentAt: input.sentAt,
      })
      .returning()
      .get();
    return toDomain(row);
  }

  async findActive(email: string, purpose: OtpPurpose, now: Date): Promise<EmailChallenge | null> {
    const row = await this.db
      .select()
      .from(emailChallenges)
      .where(
        and(
          sql`lower(${emailChallenges.email}) = lower(${email})`,
          eq(emailChallenges.purpose, purpose),
          isNull(emailChallenges.consumedAt),
          gt(emailChallenges.expiresAt, now),
        ),
      )
      .orderBy(desc(emailChallenges.createdAt))
      .get();
    return row ? toDomain(row) : null;
  }

  /**
   * コードを検証して単回消費する。
   *
   * 1 クエリの条件付き UPDATE で済ませる。`SELECT` してから `UPDATE` に
   * 分けると、同じコードを並行して投げることで試行上限を超えられたり、
   * 同じコードで 2 回ログインできたりする（仕様書 7.3）。
   *
   * 手順:
   *  1. 一致 + 使用可能を条件に `consumed_at` を立てる。成功は 1 回だけ。
   *  2. 失敗したら、なぜ失敗したかを判定するために現在の行を読む。
   *     このとき不一致なら試行回数を進める。
   */
  async consume(
    email: string,
    purpose: OtpPurpose,
    codeHash: string,
    now: Date,
  ): Promise<ConsumeResult> {
    const usable = and(
      sql`lower(${emailChallenges.email}) = lower(${email})`,
      eq(emailChallenges.purpose, purpose),
      isNull(emailChallenges.consumedAt),
      gt(emailChallenges.expiresAt, now),
      sql`${emailChallenges.attemptCount} < ${emailChallenges.maxAttempts}`,
    );

    const consumed = await this.db
      .update(emailChallenges)
      .set({ consumedAt: now })
      .where(and(usable, eq(emailChallenges.codeHash, codeHash)))
      .returning()
      .all();

    const hit = consumed[0];
    if (hit !== undefined) return { outcome: "consumed", challenge: toDomain(hit) };

    // ここから先は失敗の理由分け。まず「不一致で、まだ試行できる」場合だけ
    // 回数を進める。進められた＝コードが違っただけ、と判定できる。
    const bumped = await this.db
      .update(emailChallenges)
      .set({ attemptCount: sql`${emailChallenges.attemptCount} + 1` })
      .where(usable)
      .returning()
      .all();

    const row = bumped[0];
    if (row !== undefined) {
      return {
        outcome: "mismatch",
        attemptsRemaining: Math.max(0, row.maxAttempts - row.attemptCount),
      };
    }

    // 更新対象が無い＝期限切れ・使用済み・試行上限・不存在のいずれか。
    // 上限到達だけは「もう一致しても無駄」と伝えられるので区別する。
    const current = await this.db
      .select()
      .from(emailChallenges)
      .where(
        and(
          sql`lower(${emailChallenges.email}) = lower(${email})`,
          eq(emailChallenges.purpose, purpose),
          isNull(emailChallenges.consumedAt),
          gt(emailChallenges.expiresAt, now),
        ),
      )
      .orderBy(desc(emailChallenges.createdAt))
      .get();

    if (current !== undefined && current.attemptCount >= current.maxAttempts) {
      return { outcome: "exhausted" };
    }
    return { outcome: "unusable" };
  }

  async countSentSince(email: string, purpose: OtpPurpose, since: Date): Promise<number> {
    // 消費済み・期限切れも含めて数える。「送った事実」を数えているので、
    // 行が使えるかどうかは関係ない。除外すると invalidateActive() が
    // 送信履歴を消してしまい、上限が効かなくなる（#88）。
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(emailChallenges)
      .where(
        and(
          sql`lower(${emailChallenges.email}) = lower(${email})`,
          eq(emailChallenges.purpose, purpose),
          gt(emailChallenges.createdAt, since),
        ),
      )
      .get();
    return row?.count ?? 0;
  }

  async invalidateActive(email: string, purpose: OtpPurpose, at: Date): Promise<number> {
    const rows = await this.db
      .update(emailChallenges)
      .set({ consumedAt: at })
      .where(
        and(
          sql`lower(${emailChallenges.email}) = lower(${email})`,
          eq(emailChallenges.purpose, purpose),
          isNull(emailChallenges.consumedAt),
        ),
      )
      .returning({ id: emailChallenges.id })
      .all();
    return rows.length;
  }
}
