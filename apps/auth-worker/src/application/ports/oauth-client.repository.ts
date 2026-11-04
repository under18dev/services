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
   * 登録済みのクライアントをすべて返す（管理画面の一覧、#308）。
   *
   * **失効済みも含める。** `findByClientId` が `disabled_at` の立った行も
   * 返すのと同じ理由で、Repository は事実を返し、可否は呼び出し側が決める。
   * 一覧から失効済みを落とすと、運用者は画面で失効させた直後に行が消え、
   * 「失効したのか、消えたのか」を区別できなくなる。
   *
   * **認可フローからは呼ばない。** 全件を読む唯一のメソッドなので、
   * 使ってよいのは管理操作だけである。
   */
  listAll(): Promise<readonly OAuthClient[]>;

  /**
   * 登録済みのクライアント数（admin-worker のホーム用、#449）。
   *
   * **`listAll` を呼んで数えないこと。** 列挙する理由が無い集計だけの
   * 用途に、全件読み込みを持ち込まない——登録数が増えたときの一覧の
   * 肥大化と、集計だけしたい呼び出し側の負荷が無関係になるようにする。
   * **失効済みも数える**（`listAll` と同じ理由——事実を返す）。
   */
  count(): Promise<number>;

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

  /**
   * 持ち主を設定・変更する（#441）。**`null` を渡せば外せる。**
   *
   * `disable` と違い、一方向の遷移ではないので「既に設定済みなら false」
   * のような冪等性の WHERE 句は要らない——同じ値を渡しても、別の値に
   * 変えても、どちらも正当な呼び出しである。失効済みのクライアントの
   * 持ち主も変えられる（記録の訂正は止める理由にならない）。
   *
   * `ownerUserId` の実在確認はここでは行わない——呼び出し側
   * （`DelegatedSetOAuthClientOwnerUseCase`）が `UserRepository` で
   * 確かめてから渡す（決定 12 と同じ筋。admin-worker の申告を
   * auth-worker が信じない）。
   */
  setOwner(clientId: string, ownerUserId: string | null): Promise<boolean>;

  /**
   * 利用者が開けるアプリ本体の URL を設定・変更する（#457）。**`null` で外せる。**
   *
   * `setOwner` と同じ形——一方向の遷移ではないので冪等性の WHERE 句は要らない。
   * URL の形式検証（`https:` のみ・資格情報を含まない）はここでは行わない——
   * 呼び出し側（`DelegatedSetOAuthClientAppUrlUseCase`）が
   * `domain/services/app-url.ts` で確かめてから渡す。
   */
  setAppUrl(clientId: string, appUrl: string | null): Promise<boolean>;
}
