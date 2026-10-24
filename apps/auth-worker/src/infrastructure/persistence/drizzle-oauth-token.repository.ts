import { type IdentityDatabase, oauthTokens } from "@u18/db";
import { and, eq, isNull } from "drizzle-orm";
import type {
  IssueAccessTokenInput,
  OAuthTokenRepository,
} from "../../application/ports/oauth-token.repository";
import { AccessToken } from "../../domain/entities/access-token";

type Row = typeof oauthTokens.$inferSelect;

function toDomain(row: Row): AccessToken {
  return AccessToken.fromPersistence({
    id: row.id,
    grantId: row.grantId,
    clientId: row.clientId,
    userId: row.userId,
    scope: row.scope,
    audience: row.audience,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  });
}

export class DrizzleOAuthTokenRepository implements OAuthTokenRepository {
  constructor(private readonly db: IdentityDatabase) {}

  async issue(input: IssueAccessTokenInput): Promise<AccessToken> {
    const row = await this.db
      .insert(oauthTokens)
      .values({
        id: input.id,
        tokenHash: input.tokenHash,
        // MVP では refresh を 1 行も作らない（仕様書 1.2）。既定値に頼らず明示する。
        tokenType: "access",
        grantId: input.grantId,
        clientId: input.clientId,
        userId: input.userId,
        scope: input.scope,
        audience: input.audience,
        expiresAt: input.expiresAt,
      })
      .returning()
      .get();
    return toDomain(row);
  }

  /**
   * ハッシュで引く（#17 の `/oauth/userinfo` / `/oauth/revoke` の入口）。
   *
   * `token_type` で絞っているのは、refresh を発行し始めたときに Access Token
   * として通ってしまう経路を先に塞いでおくため。現状は access しか無いので
   * 挙動は変わらないが、条件を後から足すと「いつから入ったか」が分からなくなる。
   */
  async findByTokenHash(tokenHash: string): Promise<AccessToken | null> {
    const row = await this.db
      .select()
      .from(oauthTokens)
      .where(and(eq(oauthTokens.tokenHash, tokenHash), eq(oauthTokens.tokenType, "access")))
      .get();
    return row === undefined ? null : toDomain(row);
  }

  async revokeByTokenHash(tokenHash: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(oauthTokens)
      .set({ revokedAt: at })
      .where(and(eq(oauthTokens.tokenHash, tokenHash), isNull(oauthTokens.revokedAt)))
      .returning({ id: oauthTokens.id })
      .all();
    return rows.length > 0;
  }

  /**
   * 同意単位の一括失効。
   *
   * 同意の取り消しと、認可コードのリプレイ検出（RFC 9700 §4.1.2）から呼ばれる。
   * 期限切れの行は対象にしない——既に使えないものへ `revoked_at` を立てても
   * 意味が無く、「いつ失効させたか」の記録が実際の失効件数とずれる。
   */
  async revokeByGrant(grantId: string, at: Date): Promise<number> {
    const rows = await this.db
      .update(oauthTokens)
      .set({ revokedAt: at })
      .where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)))
      .returning({ id: oauthTokens.id })
      .all();
    return rows.length;
  }
}
