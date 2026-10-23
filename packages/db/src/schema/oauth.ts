import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, secretHash, timestampMs, updatedAt } from "./_shared";
import { users } from "./users";

/**
 * OAuth クライアント。
 *
 * MVP では内部管理のみで、公開 Developer Portal は作らない（仕様書 1.2）。
 */
export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    /** OIDC の client_id。公開される値。 */
    clientId: text("client_id").notNull(),
    name: text("name").notNull(),
    /**
     * confidential は client_secret を持ち、public は PKCE のみで認証する
     * （仕様書 5.1）。
     */
    clientType: text("client_type", { enum: ["confidential", "public"] }).notNull(),
    /** confidential のみ。ハッシュで保存し、平文は登録時に一度だけ表示する。 */
    clientSecretHash: text("client_secret_hash"),
    /** スペース区切りの許可 scope。要求 scope はこの部分集合でなければならない。 */
    allowedScopes: text("allowed_scopes").notNull().default("openid profile email"),
    /**
     * u18 公式サービスは同意画面を省略してよい（ファーストパーティ）。
     * サードパーティには必ず同意を取る。
     */
    isFirstParty: integer("is_first_party", { mode: "boolean" }).notNull().default(false),
    logoUrl: text("logo_url"),
    /** 失効させたクライアントは即座に認可を拒否する。 */
    disabledAt: timestampMs("disabled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("oauth_clients_client_id_unique").on(table.clientId)],
);

/**
 * 許可された Callback URI。
 *
 * 完全一致で検証する（仕様書 9）。ワイルドカードやプレフィックス一致は
 * オープンリダイレクトになるため持たせない。
 */
export const oauthRedirectUris = sqliteTable(
  "oauth_redirect_uris",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    /** 正規化済みの絶対 URI。クエリ・フラグメントを含めて完全一致で比較する。 */
    uri: text("uri").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("oauth_redirect_uris_unique").on(table.clientId, table.uri),
    index("oauth_redirect_uris_client_idx").on(table.clientId),
  ],
);

/**
 * 認可コード。
 *
 * コードはハッシュで保存し、`consumedAt` への条件付き UPDATE で単回交換を
 * 原子的に保証する（仕様書 7.3）。
 */
export const oauthAuthorizationCodes = sqliteTable(
  "oauth_authorization_codes",
  {
    id: text("id").primaryKey(),
    codeHash: secretHash("code_hash"),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** コードを発行した時点のセッション。ログアウト時に連鎖失効させる。 */
    sessionId: text("session_id"),
    /** 交換時に authorize 時と完全一致することを検証する。 */
    redirectUri: text("redirect_uri").notNull(),
    scope: text("scope").notNull(),
    /** PKCE。S256 のみ許可する（仕様書 5.1）。 */
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method", { enum: ["S256"] }).notNull(),
    /** ID Token にそのまま載せる。リプレイ検出のためクライアントが検証する。 */
    nonce: text("nonce"),
    /** 認可時に実際に行われた認証の時刻。ID Token の auth_time になる。 */
    authTime: timestampMs("auth_time").notNull(),
    expiresAt: timestampMs("expires_at").notNull(),
    /** 交換済みの印。NULL から非 NULL への遷移は一度しか成功しない。 */
    consumedAt: timestampMs("consumed_at"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("oauth_authorization_codes_code_hash_unique").on(table.codeHash),
    index("oauth_authorization_codes_expires_idx").on(table.expiresAt),
    index("oauth_authorization_codes_user_idx").on(table.userId),
  ],
);

/**
 * ユーザーの同意。
 *
 * 「このアプリにこの scope を許可した」という記録。ユーザーはダッシュボードから
 * 取り消せる（仕様書 1.1）。
 */
export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    /** 同意済み scope（スペース区切り）。 */
    grantedScopes: text("granted_scopes").notNull(),
    grantedAt: timestampMs("granted_at").notNull(),
    /** 取り消し時刻。取り消すと紐づくトークンも失効させる。 */
    revokedAt: timestampMs("revoked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("oauth_grants_user_client_unique").on(table.userId, table.clientId),
    index("oauth_grants_user_idx").on(table.userId),
  ],
);

/**
 * 発行済みトークン。
 *
 * Access Token を不透明トークンにするか JWT にするかは未決定（仕様書 14-5）だが、
 * どちらでも失効が要るため、ハッシュと状態をここで持つ。
 * Refresh Token は MVP では発行しない（仕様書 1.2）。
 */
export const oauthTokens = sqliteTable(
  "oauth_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: secretHash("token_hash"),
    tokenType: text("token_type", { enum: ["access", "refresh"] })
      .notNull()
      .default("access"),
    grantId: text("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    /** Audience 制限（仕様書 5.3）。 */
    audience: text("audience"),
    expiresAt: timestampMs("expires_at").notNull(),
    revokedAt: timestampMs("revoked_at"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("oauth_tokens_token_hash_unique").on(table.tokenHash),
    index("oauth_tokens_grant_idx").on(table.grantId),
    index("oauth_tokens_user_idx").on(table.userId),
    index("oauth_tokens_expires_idx").on(table.expiresAt),
  ],
);

/**
 * 署名鍵のメタデータ。
 *
 * **秘密鍵はここに保存しない**（仕様書 7.1）。秘密鍵は Workers Secret に置き、
 * ここでは kid と有効期間、JWKS へ出す公開鍵だけを管理して
 * ローテーションと旧鍵の猶予期間を表現する（仕様書 5.4）。
 */
export const signingKeyMetadata = sqliteTable(
  "signing_key_metadata",
  {
    kid: text("kid").primaryKey(),
    algorithm: text("algorithm").notNull().default("ES256"),
    /** JWKS に載せる公開鍵（JWK の JSON 文字列）。 */
    publicJwk: text("public_jwk").notNull(),
    /** この鍵で新規署名してよい期間。 */
    activeFrom: timestampMs("active_from").notNull(),
    activeUntil: timestampMs("active_until"),
    /**
     * JWKS から外してよい時刻。activeUntil 以降も、発行済みトークンの
     * 検証のためにこの時刻までは公開し続ける。
     */
    retiresAt: timestampMs("retires_at"),
    createdAt: createdAt(),
  },
  (table) => [index("signing_key_metadata_active_idx").on(table.activeFrom)],
);
