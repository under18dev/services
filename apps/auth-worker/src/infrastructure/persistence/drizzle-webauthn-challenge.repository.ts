import { type IdentityDatabase, webauthnChallenges } from "@u18/db";
import { and, eq, isNull } from "drizzle-orm";
import type {
  CreateWebAuthnChallengeInput,
  WebAuthnChallengeRepository,
} from "../../application/ports/webauthn-challenge.repository";
import {
  WebAuthnChallenge,
  type WebAuthnChallengeProps,
} from "../../domain/entities/webauthn-challenge";

type ChallengeRow = typeof webauthnChallenges.$inferSelect;

function toDomain(row: ChallengeRow): WebAuthnChallenge {
  const props: WebAuthnChallengeProps = {
    id: row.id,
    userId: row.userId,
    challenge: row.challenge,
    purpose: row.purpose,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
  };
  return WebAuthnChallenge.fromPersistence(props);
}

export class DrizzleWebAuthnChallengeRepository implements WebAuthnChallengeRepository {
  constructor(private readonly db: IdentityDatabase) {}

  async create(input: CreateWebAuthnChallengeInput): Promise<WebAuthnChallenge> {
    const row = await this.db
      .insert(webauthnChallenges)
      .values({
        id: input.id,
        userId: input.userId,
        challenge: input.challenge,
        purpose: input.purpose,
        expiresAt: input.expiresAt,
      })
      .returning()
      .get();
    return toDomain(row);
  }

  async consume(id: string, at: Date): Promise<WebAuthnChallenge | null> {
    // `consumed_at IS NULL` を条件にした UPDATE。同じ Challenge で 2 本の検証が
    // 同時に走っても、行を更新できるのは片方だけになる（仕様書 9 WebAuthn）。
    // 「引いてから消す」にすると、その間に両方が検証を通してしまう。
    const rows = await this.db
      .update(webauthnChallenges)
      .set({ consumedAt: at })
      .where(and(eq(webauthnChallenges.id, id), isNull(webauthnChallenges.consumedAt)))
      .returning()
      .all();
    const row = rows[0];
    return row ? toDomain(row) : null;
  }
}
