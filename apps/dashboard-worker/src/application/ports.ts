import type {
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
