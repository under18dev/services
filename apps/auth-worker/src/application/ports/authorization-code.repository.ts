import type { AuthorizationCode } from "../../domain/entities/authorization-code";
import type { CodeChallengeMethod } from "../../domain/services/pkce";

export interface CreateAuthorizationCodeInput {
  readonly id: string;
  /** **ハッシュを渡す。** 平文はリダイレクト応答にしか存在しない。 */
  readonly codeHash: string;
  /** `oauth_clients.id`（内部 ID）。 */
  readonly clientId: string;
  readonly userId: string;
  /** 発行時のブラウザセッション。ログアウトで未交換コードを連鎖失効させる。 */
  readonly sessionId: string | null;
  readonly redirectUri: string;
  /** スペース区切り。 */
  readonly scope: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: CodeChallengeMethod;
  readonly nonce: string | null;
  readonly authTime: Date;
  readonly expiresAt: Date;
}

/**
 * 認可コードの消費結果。
 *
 * 3 つを区別するのは、**`replayed` だけが攻撃の兆候だから**である（RFC 9700 §4.1.2）。
 * 期限切れや不存在は正常な運用でも起きるが、「一度交換に成功したコードが
 * もう一度提示された」のは、コードが 2 箇所に存在したことを意味する。
 *
 * 外部へ返す応答はいずれも `invalid_grant` に畳む。区別は監査ログと
 * 失効処理の内部判断にだけ使う。
 */
export type ConsumeAuthorizationCodeResult =
  /** 消費に成功した。この結果を受け取るのは、並行する要求のうち 1 つだけ。 */
  | { readonly outcome: "consumed"; readonly code: AuthorizationCode }
  /** 既に `consumed_at` が立っていた。リプレイとして扱う。 */
  | { readonly outcome: "replayed"; readonly code: AuthorizationCode }
  /** 不存在・期限切れ。どちらかは呼び出し側に伝えない。 */
  | { readonly outcome: "unusable" };

/**
 * 認可コードの永続化 Port（仕様書 5.3 / 7.3）。
 *
 * この Port の肝は `consume()` が「読む」と「使用済みにする」を**分けない**ことに尽きる。
 * メソッドとして `findByHash()` を生やしていないのは意図的で、生やした途端に
 * 「引いて検証してから消費する」という実装が書けてしまい、同時に届いた 2 本の
 * 交換要求が両方とも検証を通過しうる（仕様書 7.3）。
 */
export interface AuthorizationCodeRepository {
  create(input: CreateAuthorizationCodeInput): Promise<AuthorizationCode>;

  /**
   * コードを**原子的に**単回消費する。
   *
   * 実装は `UPDATE ... SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL
   * AND expires_at > ? RETURNING *` の形を取ること。SQLite は書き込みを直列化するので、
   * 同じコードへ N 本の UPDATE が同時に走っても `consumed_at IS NULL` を満たすのは
   * 最初の 1 本だけになる。
   *
   * PKCE・`redirect_uri`・`client_id` の検証は**消費した後**に行う。先に検証すると
   * そのぶん読み書きが分かれ、保証が消える。検証に落ちたコードが消費済みのまま
   * 残るのは正しい挙動で、「検証を通るまで何度でも試せるコード」を作らない。
   */
  consume(codeHash: string, now: Date): Promise<ConsumeAuthorizationCodeResult>;

  /**
   * セッションに紐づく未交換のコードをまとめて失効させる。失効させた件数を返す。
   *
   * ログアウトで呼ぶ（#15）。セッションを切ったのに、そのセッション中に発行された
   * 未交換のコードが 60 秒間生き残ると、ログアウトが「このブラウザから先へ進めなく
   * する」という利用者の期待を満たさない。
   *
   * 失効は `expires_at` を現在時刻まで引き戻すことで表現し、**`consumed_at` は
   * 触らない。** `consumed_at` を立てて失効させると、その後に正規の RP が
   * コードを提示したときリプレイ（= 攻撃の兆候）と区別できなくなり、
   * 無関係なトークンの失効と `oauth.code.replayed` の誤検知を招く。
   * 期限切れとして落とせば `unusable` に収まり、意味も実態どおりになる。
   */
  revokeUnconsumedBySession(sessionId: string, at: Date): Promise<number>;

  /**
   * ユーザーの未交換コードをまとめて失効させる。失効させた件数を返す。
   *
   * 全デバイスからのログアウトで使う。`sessionId` 単位の繰り返しにしないのは、
   * `oauth_authorization_codes.session_id` が NULL でも行として成立する
   * （列が nullable）ため。セッションを列挙して回ると、session_id を持たない
   * 行だけが取り残される。
   */
  revokeUnconsumedByUser(userId: string, at: Date): Promise<number>;
}
