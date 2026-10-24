import type {
  ConsumeResult,
  CreateEmailChallengeInput,
  EmailChallenge,
  EmailChallengeRepository,
  OtpPurpose,
} from "../src/application/ports/email-challenge.repository";
import type { EmailSender, OtpEmail } from "../src/application/ports/email-sender.port";

/**
 * 内部表現。
 *
 * `EmailChallenge` は readonly だが、fake は本物の UPDATE に相当する
 * 書き換えを再現する必要があるので、可変のコピーを持つ。
 */
type Stored = { -readonly [K in keyof EmailChallenge]: EmailChallenge[K] } & {
  codeHash: string;
};

/** 本物の原子性までは再現しないが、状態遷移は同じ順序で起こす。 */
export class InMemoryEmailChallengeRepository implements EmailChallengeRepository {
  private readonly store: Stored[] = [];

  async create(input: CreateEmailChallengeInput): Promise<EmailChallenge> {
    const row: Stored = {
      id: input.id,
      userId: input.userId,
      email: input.email,
      codeHash: input.codeHash,
      purpose: input.purpose,
      expiresAt: input.expiresAt,
      attemptCount: 0,
      maxAttempts: input.maxAttempts,
      consumedAt: null,
      lastSentAt: input.sentAt,
      createdAt: input.sentAt,
    };
    this.store.push(row);
    return row;
  }

  private active(email: string, purpose: OtpPurpose, now: Date): Stored | undefined {
    return [...this.store]
      .reverse()
      .find(
        (r) =>
          r.email.toLowerCase() === email.toLowerCase() &&
          r.purpose === purpose &&
          r.consumedAt === null &&
          r.expiresAt.getTime() > now.getTime(),
      );
  }

  async findActive(email: string, purpose: OtpPurpose, now: Date): Promise<EmailChallenge | null> {
    return this.active(email, purpose, now) ?? null;
  }

  async consume(
    email: string,
    purpose: OtpPurpose,
    codeHash: string,
    now: Date,
  ): Promise<ConsumeResult> {
    const row = this.active(email, purpose, now);
    if (row === undefined) return { outcome: "unusable" };
    if (row.attemptCount >= row.maxAttempts) return { outcome: "exhausted" };

    if (row.codeHash !== codeHash) {
      row.attemptCount += 1;
      return {
        outcome: "mismatch",
        attemptsRemaining: Math.max(0, row.maxAttempts - row.attemptCount),
      };
    }
    row.consumedAt = now;
    return { outcome: "consumed", challenge: row };
  }

  async countSentSince(email: string, purpose: OtpPurpose, since: Date): Promise<number> {
    // 本物と同じく、消費済み・期限切れも数える。ここで除外すると
    // invalidateActive() が送信履歴を消してしまい、fake だけが上限を
    // 素通りする —— テストが本物の穴を見逃す形になる（#88）。
    return this.store.filter(
      (r) =>
        r.email.toLowerCase() === email.toLowerCase() &&
        r.purpose === purpose &&
        r.createdAt.getTime() > since.getTime(),
    ).length;
  }

  /**
   * 保持期限による掃除を再現する。
   *
   * `since` より古い行が消えると上限を回り込めるか、をテストから確かめるために要る。
   */
  purgeCreatedBefore(cutoff: Date): number {
    const before = this.store.length;
    const kept = this.store.filter((r) => r.createdAt.getTime() >= cutoff.getTime());
    this.store.length = 0;
    this.store.push(...kept);
    return before - this.store.length;
  }

  async invalidateActive(email: string, purpose: OtpPurpose, at: Date): Promise<number> {
    let count = 0;
    for (const row of this.store) {
      if (
        row.email.toLowerCase() === email.toLowerCase() &&
        row.purpose === purpose &&
        row.consumedAt === null
      ) {
        row.consumedAt = at;
        count += 1;
      }
    }
    return count;
  }

  /** テストから「実際に発行されたコードのハッシュ」を取るための覗き窓。 */
  latestCodeHash(): string | undefined {
    return this.store.at(-1)?.codeHash;
  }

  size(): number {
    return this.store.length;
  }
}

export class RecordingEmailSender implements EmailSender {
  readonly sent: OtpEmail[] = [];

  async sendOtp(email: OtpEmail): Promise<void> {
    this.sent.push(email);
  }
}

/** 送信が必ず失敗するプロバイダ。応答が変わらないことの検証に使う。 */
export class FailingEmailSender implements EmailSender {
  async sendOtp(_email: OtpEmail): Promise<void> {
    throw new Error("provider is down");
  }
}
