import { oauthAuthorizationCodes, type IdentityDatabase } from "@u18/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import type {
  AuthorizationCodeRepository,
  ConsumeAuthorizationCodeResult,
  CreateAuthorizationCodeInput,
} from "../../application/ports/authorization-code.repository";
import { AuthorizationCode } from "../../domain/entities/authorization-code";

type Row = typeof oauthAuthorizationCodes.$inferSelect;

function toDomain(row: Row): AuthorizationCode {
  return AuthorizationCode.fromPersistence({
    id: row.id,
    clientId: row.clientId,
    userId: row.userId,
    sessionId: row.sessionId,
    redirectUri: row.redirectUri,
    scope: row.scope,
    codeChallenge: row.codeChallenge,
    codeChallengeMethod: row.codeChallengeMethod,
    nonce: row.nonce,
    authTime: row.authTime,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
  });
}

export class DrizzleAuthorizationCodeRepository implements AuthorizationCodeRepository {
  constructor(private readonly db: IdentityDatabase) {}

  async create(input: CreateAuthorizationCodeInput): Promise<AuthorizationCode> {
    const row = await this.db
      .insert(oauthAuthorizationCodes)
      .values({
        id: input.id,
        codeHash: input.codeHash,
        clientId: input.clientId,
        userId: input.userId,
        sessionId: input.sessionId,
        redirectUri: input.redirectUri,
        scope: input.scope,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: input.codeChallengeMethod,
        nonce: input.nonce,
        authTime: input.authTime,
        expiresAt: input.expiresAt,
      })
      .returning()
      .get();
    return toDomain(row);
  }

  /**
   * 単回交換を 1 クエリで保証する（仕様書 7.3 / #19）。
   *
   * `UPDATE ... WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING *`。
   * SQLite は書き込みを直列化するので、同じコードへ N 本の交換要求が同時に
   * 届いても `consumed_at IS NULL` を満たすのは最初の 1 本だけになり、
   * 残りは 0 行を返す。
   *
   * **ここを `SELECT` → 判定 → `UPDATE` の 2 文に分けないこと。** 分けると
   * N 本すべてが「まだ未使用」を読み、全部が検証を通ってトークンを受け取る。
   * `test/oauth-code-concurrency.test.ts` が実 D1 上でこれを固定している。
   */
  async consume(codeHash: string, now: Date): Promise<ConsumeAuthorizationCodeResult> {
    const consumed = await this.db
      .update(oauthAuthorizationCodes)
      .set({ consumedAt: now })
      .where(
        and(
          eq(oauthAuthorizationCodes.codeHash, codeHash),
          isNull(oauthAuthorizationCodes.consumedAt),
          gt(oauthAuthorizationCodes.expiresAt, now),
        ),
      )
      .returning()
      .all();

    const hit = consumed[0];
    if (hit !== undefined) {
      // 返すのは UPDATE 後の行なので `consumedAt` は埋まっている。
      // 呼び出し側が見るのは紐づく client / redirect_uri / PKCE だけ。
      return { outcome: "consumed", code: toDomain(hit) };
    }

    // ここから先は「なぜ消費できなかったか」の判定で、競合に晒されていない。
    // 既に消費済みの行が見つかった場合だけがリプレイ（RFC 9700 §4.1.2）で、
    // 失効させるべきトークンを特定するために行の中身が要る。
    const existing = await this.db
      .select()
      .from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
      .get();

    if (existing !== undefined && existing.consumedAt !== null) {
      return { outcome: "replayed", code: toDomain(existing) };
    }

    // 不存在と期限切れは区別せずに畳む。区別して返すと、コードの実在を
    // 確かめる手段になる（`GetSessionUseCase` が理由を畳むのと同じ理由）。
    return { outcome: "unusable" };
  }

  /**
   * ログアウト時の連鎖失効（#15）。
   *
   * `expires_at` を現在時刻まで引き戻す。`consumed_at` を立てないのは、
   * 後から正規の RP が提示してきたときにリプレイと誤判定し、無関係な
   * トークンを失効させてしまうため（Port のコメントを参照）。
   */
  async revokeUnconsumedBySession(sessionId: string, at: Date): Promise<number> {
    const rows = await this.db
      .update(oauthAuthorizationCodes)
      .set({ expiresAt: at })
      .where(
        and(
          eq(oauthAuthorizationCodes.sessionId, sessionId),
          isNull(oauthAuthorizationCodes.consumedAt),
          gt(oauthAuthorizationCodes.expiresAt, at),
        ),
      )
      .returning({ id: oauthAuthorizationCodes.id })
      .all();
    return rows.length;
  }

  async revokeUnconsumedByUser(userId: string, at: Date): Promise<number> {
    const rows = await this.db
      .update(oauthAuthorizationCodes)
      .set({ expiresAt: at })
      .where(
        and(
          eq(oauthAuthorizationCodes.userId, userId),
          isNull(oauthAuthorizationCodes.consumedAt),
          gt(oauthAuthorizationCodes.expiresAt, at),
        ),
      )
      .returning({ id: oauthAuthorizationCodes.id })
      .all();
    return rows.length;
  }
}
