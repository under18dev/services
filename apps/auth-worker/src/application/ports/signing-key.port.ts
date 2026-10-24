/**
 * ID Token の署名鍵（仕様書 5.4 / 7.1）。
 *
 * **秘密鍵は D1 に置かない。** 秘密鍵は Workers Secret（`SIGNING_KEY_JWK` /
 * `SIGNING_KEY_KID`）にだけ存在し、`signing_key_metadata` が持つのは
 * kid・公開 JWK・有効期間だけ。この分離があるので、D1 のバックアップや
 * Time Travel のスナップショットが漏れても ID Token は偽造できない。
 */

import type {
  SigningKeyHealth,
  SigningKeyLifecycle,
} from "../../domain/services/signing-key-rotation";

/**
 * JWKS に出す公開鍵。
 *
 * **フィールドを列挙した型にしてあるのが肝。** JWK を
 * `Record<string, unknown>` で持ち回すと、秘密鍵成分 `d` を含む JWK が
 * 紛れ込んでも型では止まらず、そのまま `/.well-known/jwks.json` から
 * 配信されうる（運用手順でも `public_jwk` に秘密鍵を貼る取り違えを
 * 警告している: docs/runbook.md 2.4.1）。実装側はこの型のフィールドだけを
 * 明示的に詰め替えることで、何が入力されても `d` が外へ出ない。
 */
export type PublicSigningJwk = {
  readonly kid: string;
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
  readonly alg: "ES256";
  readonly use: "sig";
};

/**
 * 署名に使う鍵。
 *
 * 鍵そのものは Web Crypto の `CryptoKey` で受け渡す。JWK 文字列のまま
 * 配ると、使う側が毎回 import することになり、秘密鍵の文字列が
 * 必要以上に多くの場所を通る。
 */
export type ActiveSigningKey = {
  readonly kid: string;
  readonly alg: "ES256";
  readonly privateKey: CryptoKey;
};

export interface SigningKeyProvider {
  /**
   * 新規署名に使う鍵をちょうど 1 つ返す。
   *
   * `SIGNING_KEY_JWK` は 1 本の JWK でも JWK Set でもよい。**どれで署名するかを
   * 決めるのは Secret ではなく `signing_key_metadata` の `active_from` /
   * `active_until`** で、Secret は「候補の束」でしかない（#23）。これにより
   * 鍵の切り替えが Secret の置き換えではなく DB の UPDATE 1 回になり、
   * 切り替えの瞬間に kid と鍵がちぐはぐになる窓が消える。
   *
   * 秘密鍵が未設定、どの kid も `signing_key_metadata` に無い、現在 active な
   * 鍵が 1 本も無い、あるいは Secret の鍵が行の `public_jwk` と別物だった場合は
   * **throw する**。`UnconfiguredEmailSender` /
   * `UnconfiguredIpHasher` と同じ方針で、失敗はコンテナの組み立て時ではなく
   * 「署名しようとした時点」に置く。組み立てで投げると `/health` や
   * Discovery まで 500 になる（#53）。
   */
  getActiveSigningKey(): Promise<ActiveSigningKey>;

  /**
   * JWKS に出す公開鍵の集合。
   *
   * `signing_key_metadata` が正本。`active_until` を過ぎて新規署名に
   * 使われなくなった鍵も、`retires_at` までは返し続ける —— ローテーション
   * 直前に発行した ID Token は旧 kid で署名されており、それを検証する RP が
   * まだ存在するため（仕様書 5.4 / docs/runbook.md 4.2 ステップ 5）。
   *
   * 秘密鍵を一切参照しないので、`SIGNING_KEY_JWK` が未設定でも成功する。
   * 鍵の設定漏れで JWKS まで落とさないための分離。
   */
  getPublicJwks(): Promise<readonly PublicSigningJwk[]>;

  /**
   * 署名鍵が「署名でき、かつ JWKS に出ている」かを見る（`/health`）。
   *
   * **例外を投げない。** `DatabaseProbe.ping()` と同じ契約で、設定不備も
   * D1 の不調も値として返す。`/health` は設定不備の巻き添えにならない
   * という #53 の性質を、ここで検査を足したせいで壊してはいけない。
   *
   * `getActiveSigningKey()` を流用しないのは、あちらが**失敗を例外で返す**
   * から。健全性の問い合わせのために try/catch でメッセージを読み解くと、
   * 文面を変えただけで検査の意味が変わる。判定は
   * `auditSigningKeySecret` の構造化された結論から導く。
   *
   * kid は返さない。未認証で叩ける `/health` から鍵の識別子が見えても、
   * 運用者が得るものが無い（docs/runbook.md 4.4）。
   */
  checkHealth(): Promise<SigningKeyHealth>;
}

/**
 * `signing_key_metadata` の 1 行。
 *
 * 実体は Domain の `SigningKeyLifecycle` そのもの。別に定義し直さないのは、
 * 鍵の寿命判定（`auditSigningKeySecret`）が Domain 側にあり、そこへ渡す値と
 * Repository が返す値がずれた瞬間に「DB から読めるのに判定に渡せない」が
 * 起きるため。名前だけ Port の語彙に合わせている。
 */
export type SigningKeyMetadata = SigningKeyLifecycle;

export interface SigningKeyMetadataRepository {
  /**
   * `retires_at` を迎えていない鍵をすべて返す（= JWKS に出す候補）。
   * `active_until` は見ない。旧鍵を公開し続けるのがこのメソッドの目的。
   */
  listPublishable(now: Date): Promise<readonly SigningKeyMetadata[]>;

  findByKid(kid: string): Promise<SigningKeyMetadata | null>;
}
