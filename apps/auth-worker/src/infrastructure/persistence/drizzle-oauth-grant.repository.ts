import { type IdentityDatabase, oauthClients, oauthGrants } from "@u18/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type {
  OAuthGrantRepository,
  RecordOAuthGrantInput,
  UserGrantSummary,
} from "../../application/ports/oauth-grant.repository";
import { OAuthGrant } from "../../domain/entities/oauth-grant";
import { formatScope, parseScope } from "../../domain/services/scope";

type Row = typeof oauthGrants.$inferSelect;

function toDomain(row: Row): OAuthGrant {
  return OAuthGrant.fromPersistence({
    id: row.id,
    userId: row.userId,
    clientId: row.clientId,
    grantedScopes: row.grantedScopes,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  });
}

export class DrizzleOAuthGrantRepository implements OAuthGrantRepository {
  constructor(private readonly db: IdentityDatabase) {}

  async find(userId: string, clientId: string): Promise<OAuthGrant | null> {
    const row = await this.db
      .select()
      .from(oauthGrants)
      .where(and(eq(oauthGrants.userId, userId), eq(oauthGrants.clientId, clientId)))
      .get();
    return row === undefined ? null : toDomain(row);
  }

  /**
   * ユーザーの同意を、相手クライアントの表示情報ごと引く（#18）。
   *
   * `innerJoin` にしているのは、`oauth_grants.client_id` が
   * `ON DELETE CASCADE` の外部キーだから。クライアントが消えれば同意の行も
   * 消えるので、「クライアントの無い同意」は原理的に存在しない。
   * `leftJoin` にして NULL を扱う分岐を書くと、起こらない状態への
   * 対処コードが残り、読む側に「起こりうる」と誤解させる。
   *
   * 失効済みクライアント（`disabled_at`）の同意も返す。利用者から見れば
   * 「許可した覚えのあるアプリ」であることに変わりはなく、一覧から消すと
   * 取り消す手段ごと消える。
   */
  async listByUser(userId: string): Promise<readonly UserGrantSummary[]> {
    const rows = await this.db
      .select({ grant: oauthGrants, client: oauthClients })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
      .where(eq(oauthGrants.userId, userId))
      // 新しく同意したものから並べる。UI 側で並べ替えると、取り消し直後の
      // 再描画で順序が揺れる。
      .orderBy(desc(oauthGrants.grantedAt))
      .all();

    return rows.map(({ grant, client }) => ({
      grant: toDomain(grant),
      // 外へ出すのは公開 client_id。内部 ID（`cli_...`）は漏らさない。
      clientId: client.clientId,
      clientName: client.name,
      logoUrl: client.logoUrl,
    }));
  }

  /**
   * 同意を 1 文で記録する。
   *
   * `oauth_grants_user_client_unique` を衝突点にした `ON CONFLICT DO UPDATE`。
   * 「引いて、無ければ INSERT」に分けないのは、同じ利用者が 2 つのタブで
   * 同時に同意したときに両方が「行が無い」と判断し、片方が unique 制約で
   * 落ちるため（`OAuthClientRepository.create` が存在確認をしないのと同じ理由）。
   *
   * 既存行があるときは scope を**和集合**にする。「新しい要求で上書き」に
   * すると、`openid profile email` に同意済みの利用者が `openid` だけを
   * 要求するアプリを使った瞬間、既に発行済みのトークンの根拠だった同意が
   * 黙って狭まる。
   *
   * `revoked_at` は同時に NULL へ戻す。取り消した後にもう一度同意を取ったので、
   * 取り消しの記録を残したまま「取り消し済みの同意」として扱うほうが実態と合わない。
   */
  async record(input: RecordOAuthGrantInput): Promise<OAuthGrant> {
    const existing = await this.find(input.userId, input.clientId);

    // 和集合の計算は SQL 側では書きづらい（スペース区切りの文字列なので）。
    // 読んだ値を基に合成するが、**書き込み自体は 1 文**なので、同時実行で
    // 行が増えることはない。最悪「同時に広げた片方の scope が落ちる」
    // だけで、落ちた側は次の認可要求で同意画面に戻るので安全側に倒れる。
    const merged =
      existing === null || existing.isRevoked
        ? input.grantedScopes
        : formatScope([...existing.scopes, ...parseScope(input.grantedScopes)]);

    const row = await this.db
      .insert(oauthGrants)
      .values({
        id: input.id,
        userId: input.userId,
        clientId: input.clientId,
        grantedScopes: merged,
        grantedAt: input.at,
      })
      .onConflictDoUpdate({
        target: [oauthGrants.userId, oauthGrants.clientId],
        set: {
          grantedScopes: merged,
          grantedAt: input.at,
          revokedAt: sql`null`,
          updatedAt: input.at,
        },
      })
      .returning()
      .get();

    return toDomain(row);
  }

  async revoke(userId: string, clientId: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(oauthGrants)
      .set({ revokedAt: at })
      .where(
        and(
          eq(oauthGrants.userId, userId),
          eq(oauthGrants.clientId, clientId),
          // 既に取り消し済みなら最初の時刻を上書きしない（`disable` と同じ方針）。
          isNull(oauthGrants.revokedAt),
        ),
      )
      .returning({ id: oauthGrants.id })
      .all();
    return rows.length > 0;
  }
}
