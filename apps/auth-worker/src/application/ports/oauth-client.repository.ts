import type { OAuthClient, OAuthClientType } from "../../domain/entities/oauth-client";

export interface CreateOAuthClientInput {
  /** 内部 ID（`cli_...`）。 */
  readonly id: string;
  /** OIDC の `client_id`。 */
  readonly clientId: string;
  readonly name: string;
  readonly clientType: OAuthClientType;
  /**
   * confidential のみ。**平文ではなくハッシュ**を渡す。
   * 平文は呼び出し元が一度だけ表示し、どこにも残さない。
   */
  readonly clientSecretHash: string | null;
  /** スペース区切り。 */
  readonly allowedScopes: string;
  readonly isFirstParty: boolean;
  readonly logoUrl: string | null;
  /**
   * 登録する Redirect URI。
   * `domain/services/redirect-uri.ts` の検証を通ったものだけを渡すこと。
   */
  readonly redirectUris: readonly string[];
}

/**
 * OAuth クライアント永続化の Port。
 *
 * MVP に公開 Developer Portal は無く（仕様書 1.2）、登録は内部の CLI から
 * 行う（`scripts/oauth-client.mjs`）。したがってこの Port の読み取り側は
 * 認可フロー、書き込み側は管理操作、という非対称な使われ方になる。
 */
export interface OAuthClientRepository {
  /**
   * `client_id` でクライアントを引く。
   *
   * `disabled_at` が立っていても行は返す。使ってよいかの判断は
   * `OAuthClient.isDisabled` に寄せ、Session と同じく「Repository は事実を返し、
   * 可否は Domain が決める」形を崩さない。呼び出し側は必ず
   * `AuthenticateOAuthClientUseCase` / `ResolveOAuthClientUseCase` を経由すること。
   *
   * Redirect URI は同じ呼び出しで読み込む。クライアントと URI を別々に
   * 読むと、その間に URI が足された状態を跨いで判断する余地ができる。
   */
  findByClientId(clientId: string): Promise<OAuthClient | null>;

  /** 管理操作・重複確認用。認可フローでは `findByClientId` の結果を使う。 */
  listRedirectUris(clientId: string): Promise<readonly string[]>;

  /**
   * confidential クライアントの `client_secret` を照合する。
   *
   * 平文を受け取り、ハッシュ化と**定時間比較**まで実装側で完結させる。
   * `where client_secret_hash = ?` のように DB へ比較させないこと。
   * 比較が早期脱出すると、応答時間からハッシュを 1 バイトずつ特定できる。
   *
   * public クライアント・失効済みクライアント・未登録の `client_id` は
   * すべて false。「秘密が違う」と「クライアントが無い」を区別しない。
   */
  verifySecret(clientId: string, presentedSecret: string): Promise<boolean>;

  /**
   * 新規登録する。`client_id` が既に使われていれば `null`。
   *
   * 二重登録は DB の unique index で止める。「存在するか確認してから挿す」に
   * 分けると、同時実行で 2 行入りうる。
   */
  create(input: CreateOAuthClientInput): Promise<OAuthClient | null>;

  /** 失効させる。すでに失効済みなら false（冪等）。 */
  disable(clientId: string, at: Date): Promise<boolean>;
}
