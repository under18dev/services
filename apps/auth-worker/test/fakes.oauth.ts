import type {
  AuthorizationCodeRepository,
  ConsumeAuthorizationCodeResult,
  CreateAuthorizationCodeInput,
} from "../src/application/ports/authorization-code.repository";
import type { IdTokenClaims, IdTokenIssuer } from "../src/application/ports/id-token.port";
import type {
  CreateOAuthClientInput,
  OAuthClientRepository,
} from "../src/application/ports/oauth-client.repository";
import type {
  OAuthGrantRepository,
  RecordOAuthGrantInput,
  UserGrantSummary,
} from "../src/application/ports/oauth-grant.repository";
import type {
  IssueAccessTokenInput,
  OAuthTokenRepository,
} from "../src/application/ports/oauth-token.repository";
import type {
  SigningKeyMetadata,
  SigningKeyMetadataRepository,
} from "../src/application/ports/signing-key.port";
import { AccessToken, type AccessTokenProps } from "../src/domain/entities/access-token";
import {
  AuthorizationCode,
  type AuthorizationCodeProps,
} from "../src/domain/entities/authorization-code";
import { OAuthClient, type OAuthClientProps } from "../src/domain/entities/oauth-client";
import { OAuthGrant, type OAuthGrantProps } from "../src/domain/entities/oauth-grant";
import { formatScope, parseScope } from "../src/domain/services/scope";

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

  async listAll(): Promise<readonly OAuthClient[]> {
    // 本物と同じく失効済みも返す。`Map` の挿入順＝登録順なので、
    // D1 側の `order by created_at` と同じ並びになる。
    return [...this.store.values()].map((props) => OAuthClient.fromPersistence(props));
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

/**
 * 認可コードのインメモリ実装。
 *
 * **`consume()` の原子性だけは再現できない。** 単一スレッドの Map なので
 * 「同時に 2 本」という状況そのものが作れず、SELECT → 判定 → UPDATE の
 * 実装でも通ってしまう。同時交換の検証は実 D1（miniflare）で行うこと
 * （`test/oauth-code-concurrency.test.ts`、#19）。このフェイクが担うのは
 * 「消費してから検証する」という順序と、リプレイ検出の分岐だけである。
 */
export class InMemoryAuthorizationCodeRepository implements AuthorizationCodeRepository {
  private readonly rows = new Map<string, AuthorizationCodeProps & { codeHash: string }>();

  async create(input: CreateAuthorizationCodeInput): Promise<AuthorizationCode> {
    const props: AuthorizationCodeProps & { codeHash: string } = {
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
      consumedAt: null,
      createdAt: new Date(),
    };
    this.rows.set(input.codeHash, props);
    return AuthorizationCode.fromPersistence(props);
  }

  async consume(codeHash: string, now: Date): Promise<ConsumeAuthorizationCodeResult> {
    const row = this.rows.get(codeHash);
    if (row === undefined) return { outcome: "unusable" };

    if (row.consumedAt !== null) {
      return { outcome: "replayed", code: AuthorizationCode.fromPersistence(row) };
    }
    if (row.expiresAt.getTime() <= now.getTime()) return { outcome: "unusable" };

    const consumed = { ...row, consumedAt: now };
    this.rows.set(codeHash, consumed);
    return { outcome: "consumed", code: AuthorizationCode.fromPersistence(consumed) };
  }

  async revokeUnconsumedBySession(sessionId: string, at: Date): Promise<number> {
    return this.expire((row) => row.sessionId === sessionId, at);
  }

  async revokeUnconsumedByUser(userId: string, at: Date): Promise<number> {
    return this.expire((row) => row.userId === userId, at);
  }

  /** 本物と同じく `expires_at` を引き戻す（`consumed_at` は触らない）。 */
  private expire(matches: (row: AuthorizationCodeProps) => boolean, at: Date): number {
    let count = 0;
    for (const [hash, row] of this.rows) {
      if (!matches(row) || row.consumedAt !== null || row.expiresAt.getTime() <= at.getTime()) {
        continue;
      }
      this.rows.set(hash, { ...row, expiresAt: at });
      count += 1;
    }
    return count;
  }
}

/** 同意のインメモリ実装。 */
export class InMemoryOAuthGrantRepository implements OAuthGrantRepository {
  private readonly rows = new Map<string, OAuthGrantProps>();

  private key(userId: string, clientId: string): string {
    return `${userId}\u0000${clientId}`;
  }

  seed(props: OAuthGrantProps): void {
    this.rows.set(this.key(props.userId, props.clientId), props);
  }

  async find(userId: string, clientId: string): Promise<OAuthGrant | null> {
    const row = this.rows.get(this.key(userId, clientId));
    return row === undefined ? null : OAuthGrant.fromPersistence(row);
  }

  /**
   * 本物と同じく、取り消し済みも含めて返す（絞るのは UseCase の仕事）。
   *
   * クライアントの表示情報はこの fake が知らないので、内部 ID から
   * 決まる形の値を入れておく。一覧の中身そのものを検証したいテストは
   * 実 D1 を使う `oauth-grants.rpc.test.ts` 側にある。
   */
  async listByUser(userId: string): Promise<readonly UserGrantSummary[]> {
    return [...this.rows.values()]
      .filter((row) => row.userId === userId)
      .map((row) => ({
        grant: OAuthGrant.fromPersistence(row),
        clientId: row.clientId,
        clientName: `client ${row.clientId}`,
        logoUrl: null,
      }));
  }

  async record(input: RecordOAuthGrantInput): Promise<OAuthGrant> {
    const key = this.key(input.userId, input.clientId);
    const existing = this.rows.get(key);

    // 本物と同じく、既存の同意があれば scope を和集合にし、取り消しは解除する。
    const merged =
      existing === undefined || existing.revokedAt !== null
        ? input.grantedScopes
        : formatScope([...parseScope(existing.grantedScopes), ...parseScope(input.grantedScopes)]);

    const props: OAuthGrantProps = {
      id: existing?.id ?? input.id,
      userId: input.userId,
      clientId: input.clientId,
      grantedScopes: merged,
      grantedAt: input.at,
      revokedAt: null,
      createdAt: existing?.createdAt ?? input.at,
    };
    this.rows.set(key, props);
    return OAuthGrant.fromPersistence(props);
  }

  async revoke(userId: string, clientId: string, at: Date): Promise<boolean> {
    const key = this.key(userId, clientId);
    const row = this.rows.get(key);
    if (row === undefined || row.revokedAt !== null) return false;
    this.rows.set(key, { ...row, revokedAt: at });
    return true;
  }
}

/** 発行済み Access Token のインメモリ実装。 */
export class InMemoryOAuthTokenRepository implements OAuthTokenRepository {
  private readonly rows = new Map<string, AccessTokenProps & { tokenHash: string }>();

  async issue(input: IssueAccessTokenInput): Promise<AccessToken> {
    const props: AccessTokenProps & { tokenHash: string } = {
      id: input.id,
      tokenHash: input.tokenHash,
      grantId: input.grantId,
      clientId: input.clientId,
      userId: input.userId,
      scope: input.scope,
      audience: input.audience,
      expiresAt: input.expiresAt,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.rows.set(input.tokenHash, props);
    return AccessToken.fromPersistence(props);
  }

  async findByTokenHash(tokenHash: string): Promise<AccessToken | null> {
    const row = this.rows.get(tokenHash);
    return row === undefined ? null : AccessToken.fromPersistence(row);
  }

  async revokeByTokenHash(tokenHash: string, at: Date): Promise<boolean> {
    const row = this.rows.get(tokenHash);
    if (row === undefined || row.revokedAt !== null) return false;
    this.rows.set(tokenHash, { ...row, revokedAt: at });
    return true;
  }

  async revokeByGrant(grantId: string, at: Date): Promise<number> {
    let count = 0;
    for (const [hash, row] of this.rows) {
      if (row.grantId !== grantId || row.revokedAt !== null) continue;
      this.rows.set(hash, { ...row, revokedAt: at });
      count += 1;
    }
    return count;
  }

  /** 検証用。発行済みの全行を返す。 */
  all(): readonly AccessToken[] {
    return [...this.rows.values()].map((row) => AccessToken.fromPersistence(row));
  }
}

/**
 * ID Token の発行を記録するだけのフェイク。
 *
 * 署名の中身（ES256・kid・JWKS との対応）は `test/oauth-token.test.ts` が
 * 本物の `JoseIdTokenIssuer` と `jose` の検証器で確かめる。こちらは
 * 「どの claim を渡したか」を見るためだけに使う。
 */
export class RecordingIdTokenIssuer implements IdTokenIssuer {
  readonly issued: IdTokenClaims[] = [];
  /** `getActiveSigningKey()` の失敗を再現したいときに立てる。 */
  failWith: Error | null = null;

  async issue(claims: IdTokenClaims): Promise<string> {
    if (this.failWith !== null) throw this.failWith;
    this.issued.push(claims);
    return `id-token:${this.issued.length}`;
  }
}
