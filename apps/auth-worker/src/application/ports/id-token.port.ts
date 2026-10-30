/**
 * ID Token の発行（仕様書 5.3 / 5.4 / 14-1 の決定 6）。
 *
 * ## なぜ UseCase が直接 `jose` を呼ばないのか
 *
 * `SigningKeyProvider` は `CryptoKey` を返すので、技術的には UseCase から
 * `SignJWT` を呼べる。そうしていないのは 2 つの理由による。
 *
 * 1. **アルゴリズムを 1 箇所に閉じる。** `alg` を選ぶコードが Application に
 *    散ると、「ここだけ HS256 でも通る」という分岐が後から生えうる。
 *    仕様書 9 は署名アルゴリズムの固定を要求しており、`alg: none` や
 *    対称鍵への降格を型の上で不可能にしておきたい。この Port は `alg` を
 *    引数に取らない。
 * 2. JWT の直列化は暗号ライブラリの関心事で、Application が持つべき判断
 *    （誰に・どの claim を・どれだけの期間）とは別物である。
 *
 * ## 失敗は throw で返す
 *
 * 鍵が未設定・kid が未登録・`active_until` を過ぎている場合、実装は
 * `SigningKeyProvider.getActiveSigningKey()` の例外をそのまま伝播させる。
 * これは利用者の入力の誤りではなくインフラの設定不備なので、
 * `UseCaseResult` の失敗として並べると「クライアントが直せる誤り」と
 * 混ざる。呼び出す UseCase 側で捕まえて `server_error` へ翻訳すること。
 */

export type IdTokenClaims = {
  readonly issuer: string;
  /** OIDC の `sub`。`users.id` を使う（username / email は変わりうる）。 */
  readonly subject: string;
  /** `aud`。発行先の公開 `client_id`。 */
  readonly audience: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /** 認可の元になった認証の時刻。`auth_time` として秒精度で載る。 */
  readonly authTime: Date;
  /** 認可要求に `nonce` があればそのまま載せる。無ければ claim 自体を出さない。 */
  readonly nonce: string | null;
  /**
   * 認証方式（RFC 8176 の `amr`、#390）。**`auth_time` と同じ扱い** ——
   * scope に関わらず常に載る base claim で、`additionalClaims` を通さない。
   * セッションへ解決できなかった場合（`sessionId` が無い、既に失効した等）
   * は `null` にし、claim 自体を出さない。**存在しないことは「弱い」とは
   * 違う**ので、空配列で埋めない。
   *
   * `userinfo` には載せない。`auth_time` と同じく「特定の認証イベントに
   * ついての事実」で、`/oauth/userinfo` が答える「いまの利用者の属性」とは
   * 性質が違う（`user.toClaims()` が `auth_time` を持たないのと同じ理由）。
   */
  readonly amr: readonly string[] | null;
  /**
   * `acr`（RFC 8176 / OIDC Core、#390）。**u18 が定義する水準を満たしたか
   * だけを答える。** 満たさなければ `null`（claim を出さない）—— 「u18 に
   * acr という概念が無い」と「要求された水準に届かなかった」を区別しない。
   * `domain/services/amr.ts` の `acrFor` を参照。
   */
  readonly acr: string | null;
  /**
   * scope に応じた追加 claim（`profile` / `email`）。
   * `filterClaimsByScope()` を通した結果を渡すこと。
   */
  readonly additionalClaims: Record<string, unknown>;
};

export interface IdTokenIssuer {
  /** ES256 で署名した ID Token（JWS Compact）を返す。ヘッダに `kid` を含む。 */
  issue(claims: IdTokenClaims): Promise<string>;
}
