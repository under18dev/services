import type {
  OAuthClientSummary,
  PasskeySummary,
  GrantListItem,
  IdentityPing,
  SessionListItem,
  SessionSummary,
  UserProfile,
} from "@u18/contracts";
import type { IdentityFailure } from "../domain/errors";

export type IdentityOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: IdentityFailure };

/**
 * Identity への問い合わせ Port。
 *
 * RPC の呼び出しは Infrastructure adapter に閉じ込める（仕様書 4.4）。
 * Application はこのインターフェースだけを見るので、Service Binding を
 * HTTP 呼び出しへ置き換えても上の層は変わらない。
 */
export interface IdentityGateway {
  getSession(sessionToken: string): Promise<IdentityOutcome<SessionSummary | null>>;
  getProfile(sessionToken: string): Promise<IdentityOutcome<UserProfile | null>>;
  listSessions(sessionToken: string): Promise<IdentityOutcome<readonly SessionListItem[]>>;
  updateProfile(
    sessionToken: string,
    changes: { displayName?: string; username?: string },
  ): Promise<IdentityOutcome<{ profile: UserProfile; changedFields: readonly string[] }>>;
  listPasskeys(sessionToken: string): Promise<IdentityOutcome<readonly PasskeySummary[]>>;
  deletePasskey(
    sessionToken: string,
    passkeyId: string,
  ): Promise<IdentityOutcome<{ deleted: boolean; remaining: number }>>;
  /**
   * 本人の退会（#318）。**冪等でない**ので adapter は自動リトライしない。
   *
   * **「削除」ではない。** `status` が `suspended` になりログインが塞がる
   * だけで、氏名相当とメールアドレスは残る（落とすのは管理者の §11.6）。
   */
  closeAccount(
    sessionToken: string,
  ): Promise<IdentityOutcome<{ closed: boolean; revokedSessions: number }>>;
  revokeSession(
    sessionToken: string,
    targetSessionId: string,
  ): Promise<IdentityOutcome<{ revoked: boolean; self: boolean }>>;
  /** 同意済みアプリの一覧（#18）。 */
  listGrants(sessionToken: string): Promise<IdentityOutcome<readonly GrantListItem[]>>;
  /**
   * 同意を取り消す。`clientId` は公開 `client_id`。
   *
   * `revokeSession` と同じく**冪等でない**ので、adapter は自動リトライしない。
   */
  revokeGrant(
    sessionToken: string,
    clientId: string,
  ): Promise<IdentityOutcome<{ revoked: boolean; revokedTokenCount: number }>>;
  /**
   * 死活確認（#44）。認証を要さず、個人情報も返さない。
   *
   * 応答が無いまま待ち続けないよう、adapter 側でタイムアウトを課す。
   * auth-worker の遅延が dashboard の `/health` の遅延になると、
   * 監視から見て「落ちている」と「遅い」の区別が付かなくなる。
   */
  pingIdentity(): Promise<IdentityOutcome<IdentityPing>>;
}

/**
 * 管理者だけが使う Identity の口（#308 / #333）。
 *
 * ## なぜ `IdentityGateway` と分けるのか
 *
 * **向こう側が別の Entrypoint だから**である。auth-worker は
 * `IdentityRPC` と `IdentityAdminRPC` を分けており、束縛の単位は
 * Entrypoint なので、**どちらを呼べるかは `wrangler.jsonc` で決まる**
 * （`scripts/check-service-bindings.mjs` が静的に検査する）。
 * 1 つの Port にまとめると、その境界がこちら側の型から消える。
 *
 * ## 認可はこちらで決めていない
 *
 * 管理者でないセッションには auth-worker が `not_found` を返す
 * （`application/use-cases/admin-access.ts`）。**この Port を呼べること
 * と、呼んで通ることは別である。** 画面が `isAdmin` を見て入口を隠すのは
 * 利用者のための配慮で、守っているのは向こう側。
 */
export interface IdentityAdminGateway {
  listOAuthClients(sessionToken: string): Promise<IdentityOutcome<readonly OAuthClientSummary[]>>;
  /**
   * クライアントを登録する。**冪等でない**ので adapter は自動リトライしない。
   *
   * 戻り値の `clientSecret` は**平文で、この応答にしか存在しない**
   * （public クライアントでは null）。**ログにも画面の URL にも載せないこと。**
   */
  createOAuthClient(
    sessionToken: string,
    input: {
      readonly clientId: string;
      readonly name: string;
      readonly clientType: "confidential" | "public";
      readonly redirectUris: readonly string[];
      readonly scopes?: readonly string[];
      readonly logoUrl?: string | null;
    },
  ): Promise<IdentityOutcome<{ client: OAuthClientSummary; clientSecret: string | null }>>;
  /** 失効させる。冪等（2 度目は `disabled: false`）。 */
  disableOAuthClient(
    sessionToken: string,
    clientId: string,
  ): Promise<IdentityOutcome<{ disabled: boolean }>>;
}
