import { type IdentityDatabase, signingKeyMetadata } from "@u18/db";
import { asc, eq, gt, isNull, or } from "drizzle-orm";
import type {
  SigningKeyMetadata,
  SigningKeyMetadataRepository,
} from "../../application/ports/signing-key.port";

type SigningKeyRow = typeof signingKeyMetadata.$inferSelect;

function toMetadata(row: SigningKeyRow): SigningKeyMetadata {
  return {
    kid: row.kid,
    algorithm: row.algorithm,
    publicJwk: row.publicJwk,
    activeFrom: row.activeFrom,
    activeUntil: row.activeUntil,
    retiresAt: row.retiresAt,
  };
}

export class DrizzleSigningKeyMetadataRepository implements SigningKeyMetadataRepository {
  constructor(private readonly db: IdentityDatabase) {}

  async listPublishable(now: Date): Promise<readonly SigningKeyMetadata[]> {
    // 絞るのは `retires_at` だけ。`active_until` を過ぎた鍵も返す。
    // 旧鍵で署名された発行済みトークンを RP が検証できなくなるため
    // （仕様書 5.4 / docs/runbook.md 4.2 ステップ 5）。
    //
    // `retires_at IS NULL` は「撤去予定なし」であって「撤去済み」ではない。
    // 落とさないこと。
    const rows = await this.db
      .select()
      .from(signingKeyMetadata)
      .where(or(isNull(signingKeyMetadata.retiresAt), gt(signingKeyMetadata.retiresAt, now)))
      .orderBy(asc(signingKeyMetadata.activeFrom))
      .all();
    return rows.map(toMetadata);
  }

  async findByKid(kid: string): Promise<SigningKeyMetadata | null> {
    const row = await this.db
      .select()
      .from(signingKeyMetadata)
      .where(eq(signingKeyMetadata.kid, kid))
      .get();
    return row ? toMetadata(row) : null;
  }
}
