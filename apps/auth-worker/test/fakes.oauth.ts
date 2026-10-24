import type {
  CreateOAuthClientInput,
  OAuthClientRepository,
} from "../src/application/ports/oauth-client.repository";
import type {
  SigningKeyMetadata,
  SigningKeyMetadataRepository,
} from "../src/application/ports/signing-key.port";
import { OAuthClient, type OAuthClientProps } from "../src/domain/entities/oauth-client";

/**
 * OAuth クライアントのインメモリ実装（仕様書 11.1）。
 *
 * 本物と同じく、平文の `client_secret` は持たない。`verifySecret` に渡された
 * 値をハッシュ化して比較する手順まで再現する（ハッシュは `hash:` 前置の
 * テスト用で、`FakeHasher` と対になる）。
 */
export class InMemoryOAuthClientRepository implements OAuthClientRepository {
  private readonly store = new Map<string, OAuthClientProps>();
  private readonly secretHashes = new Map<string, string>();

  /** クライアントを直接流し込む。`secret` を渡すと confidential 認証に使える。 */
  seed(props: OAuthClientProps, secret?: string): OAuthClient {
    this.store.set(props.clientId, props);
    if (secret !== undefined) this.secretHashes.set(props.clientId, `hash:${secret}`);
    return OAuthClient.fromPersistence(props);
  }

  async findByClientId(clientId: string): Promise<OAuthClient | null> {
    const props = this.store.get(clientId);
    // 本物と同じく、失効済みでも行は返す。可否判断は Domain / UseCase の仕事。
    return props ? OAuthClient.fromPersistence(props) : null;
  }

  async listRedirectUris(clientId: string): Promise<readonly string[]> {
    return this.store.get(clientId)?.redirectUris ?? [];
  }

  async verifySecret(clientId: string, presentedSecret: string): Promise<boolean> {
    const props = this.store.get(clientId);
    if (props === undefined) return false;
    if (props.clientType !== "confidential") return false;
    if (props.disabledAt !== null) return false;

    const stored = this.secretHashes.get(clientId);
    return stored !== undefined && stored === `hash:${presentedSecret}`;
  }

  async create(input: CreateOAuthClientInput): Promise<OAuthClient | null> {
    if (this.store.has(input.clientId)) return null;
    const props: OAuthClientProps = {
      id: input.id,
      clientId: input.clientId,
      name: input.name,
      clientType: input.clientType,
      allowedScopes: input.allowedScopes,
      isFirstParty: input.isFirstParty,
      logoUrl: input.logoUrl,
      disabledAt: null,
      redirectUris: [...new Set(input.redirectUris)],
      createdAt: new Date(),
    };
    this.store.set(props.clientId, props);
    if (input.clientSecretHash !== null) {
      this.secretHashes.set(props.clientId, input.clientSecretHash);
    }
    return OAuthClient.fromPersistence(props);
  }

  async disable(clientId: string, at: Date): Promise<boolean> {
    const props = this.store.get(clientId);
    if (props === undefined || props.disabledAt !== null) return false;
    this.store.set(clientId, { ...props, disabledAt: at });
    return true;
  }
}

/** `signing_key_metadata` のインメモリ実装。 */
export class InMemorySigningKeyMetadataRepository implements SigningKeyMetadataRepository {
  private readonly rows: SigningKeyMetadata[] = [];

  seed(row: SigningKeyMetadata): void {
    this.rows.push(row);
  }

  async listPublishable(now: Date): Promise<readonly SigningKeyMetadata[]> {
    // 本物と同じく `retires_at` だけで絞る。`active_until` では絞らない。
    return this.rows.filter(
      (row) => row.retiresAt === null || row.retiresAt.getTime() > now.getTime(),
    );
  }

  async findByKid(kid: string): Promise<SigningKeyMetadata | null> {
    return this.rows.find((row) => row.kid === kid) ?? null;
  }
}
