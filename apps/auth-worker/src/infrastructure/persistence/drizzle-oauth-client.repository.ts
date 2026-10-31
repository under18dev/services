import { type IdentityDatabase, oauthClients, oauthRedirectUris } from "@u18/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { ConstantTimeComparator, TokenHasher } from "../../application/ports/crypto.port";
import type {
  CreateOAuthClientInput,
  OAuthClientRepository,
} from "../../application/ports/oauth-client.repository";
import { OAuthClient, type OAuthClientProps } from "../../domain/entities/oauth-client";

type OAuthClientRow = typeof oauthClients.$inferSelect;

function toDomain(row: OAuthClientRow, redirectUris: readonly string[]): OAuthClient {
  // 行型をそのまま Domain へ渡さず、必要な列だけ明示的に写す（仕様書 7.2）。
  // `client_secret_hash` をここで落としているのが重要で、Domain から先へ
  // ハッシュが流れる経路を型レベルで断っている。
  const props: OAuthClientProps = {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    clientType: row.clientType,
    allowedScopes: row.allowedScopes,
    isFirstParty: row.isFirstParty,
    logoUrl: row.logoUrl,
    disabledAt: row.disabledAt,
    redirectUris,
    createdAt: row.createdAt,
  };
  return OAuthClient.fromPersistence(props);
}

export class DrizzleOAuthClientRepository implements OAuthClientRepository {
  constructor(
    private readonly db: IdentityDatabase,
    private readonly hasher: TokenHasher,
    private readonly comparator: ConstantTimeComparator,
  ) {}

  async findByClientId(clientId: string): Promise<OAuthClient | null> {
    // クライアントと Redirect URI を 1 回の問い合わせで読む。
    // 2 回に分けると、その間に URI が足された／消えた状態を跨いで
    // 認可判断をする余地が生まれる。
    const rows = await this.db
      .select({ client: oauthClients, uri: oauthRedirectUris.uri })
      .from(oauthClients)
      .leftJoin(oauthRedirectUris, eq(oauthRedirectUris.clientId, oauthClients.id))
      .where(eq(oauthClients.clientId, clientId))
      .all();

    const first = rows[0];
    if (first === undefined) return null;

    const uris = rows.map((row) => row.uri).filter((uri): uri is string => uri !== null);
    return toDomain(first.client, uris);
  }

  async listRedirectUris(clientId: string): Promise<readonly string[]> {
    const rows = await this.db
      .select({ uri: oauthRedirectUris.uri })
      .from(oauthRedirectUris)
      .innerJoin(oauthClients, eq(oauthRedirectUris.clientId, oauthClients.id))
      .where(eq(oauthClients.clientId, clientId))
      .all();
    return rows.map((row) => row.uri);
  }

  async listAll(): Promise<readonly OAuthClient[]> {
    // `findByClientId` と同じく、クライアントと Redirect URI を 1 回の
    // 問い合わせで読む。件数は運用者が登録した数（数十の桁）なので、
    // ページングは置かない —— 置くと「続きがある一覧」を扱う分岐が
    // 呼び出し側に増え、全件を見たい管理画面の用途と合わない。
    const rows = await this.db
      .select({ client: oauthClients, uri: oauthRedirectUris.uri })
      .from(oauthClients)
      .leftJoin(oauthRedirectUris, eq(oauthRedirectUris.clientId, oauthClients.id))
      .orderBy(oauthClients.createdAt)
      .all();

    // join で行が増えるので、内部 ID で畳む。`Map` は挿入順を保つため、
    // 上の `order by created_at` がそのまま結果の順序になる。
    const uris = new Map<string, string[]>();
    const clients = new Map<string, OAuthClientRow>();
    for (const row of rows) {
      clients.set(row.client.id, row.client);
      if (row.uri === null) continue;
      const list = uris.get(row.client.id);
      if (list === undefined) uris.set(row.client.id, [row.uri]);
      else list.push(row.uri);
    }

    return [...clients.values()].map((client) => toDomain(client, uris.get(client.id) ?? []));
  }

  /**
   * 登録済みのクライアント数（#449）。**`count(*)` 1 本。** `listAll` の
   * ような join・`Map` での畳み込みは要らない——集計だけが欲しい
   * 呼び出し側に、全件読み込みの負荷を持ち込まない。
   */
  async count(): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(oauthClients)
      .get();
    return row?.count ?? 0;
  }

  async verifySecret(clientId: string, presentedSecret: string): Promise<boolean> {
    const row = await this.db
      .select({
        clientType: oauthClients.clientType,
        secretHash: oauthClients.clientSecretHash,
        disabledAt: oauthClients.disabledAt,
      })
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .get();

    if (row === undefined) return false;
    // public クライアントは secret を持たない。hash 列が NULL なので
    // 下の比較でも落ちるが、意図を明示するために先に弾く。
    if (row.clientType !== "confidential") return false;
    if (row.disabledAt !== null) return false;
    if (row.secretHash === null) return false;

    // ハッシュ化してから定時間比較する。`where client_secret_hash = ?` で
    // DB に比較させないのは、SQLite の文字列比較が最初の不一致で打ち切られ、
    // 応答時間からハッシュを 1 バイトずつ絞り込めてしまうため。
    const presentedHash = await this.hasher.hash(presentedSecret);
    return this.comparator.equals(presentedHash, row.secretHash);
  }

  async create(input: CreateOAuthClientInput): Promise<OAuthClient | null> {
    // `client_id` の unique index に任せる。先に SELECT で存在確認する形だと、
    // 同時に 2 本走ったときに両方が「無い」と判断しうる。
    const row = await this.db
      .insert(oauthClients)
      .values({
        id: input.id,
        clientId: input.clientId,
        name: input.name,
        clientType: input.clientType,
        clientSecretHash: input.clientSecretHash,
        allowedScopes: input.allowedScopes,
        isFirstParty: input.isFirstParty,
        logoUrl: input.logoUrl,
      })
      .onConflictDoNothing({ target: oauthClients.clientId })
      .returning()
      .get();

    if (row === undefined) return null;

    const uris = [...new Set(input.redirectUris)];
    if (uris.length > 0) {
      await this.db
        .insert(oauthRedirectUris)
        .values(
          uris.map((uri) => ({
            id: `uri_${crypto.randomUUID()}`,
            clientId: row.id,
            uri,
          })),
        )
        .run();
    }

    return toDomain(row, uris);
  }

  async disable(clientId: string, at: Date): Promise<boolean> {
    // `disabled_at IS NULL` を条件に入れて、二重失効で時刻が上書きされるのを防ぐ
    // （DrizzleSessionRepository.revoke と同じ形）。
    const rows = await this.db
      .update(oauthClients)
      .set({ disabledAt: at })
      .where(and(eq(oauthClients.clientId, clientId), isNull(oauthClients.disabledAt)))
      .returning({ id: oauthClients.id })
      .all();
    return rows.length > 0;
  }
}
