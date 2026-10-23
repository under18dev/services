import type { SessionListItem, SessionSummary, UserProfile } from "@u18/contracts";
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
  revokeSession(
    sessionToken: string,
    targetSessionId: string,
  ): Promise<IdentityOutcome<{ revoked: boolean }>>;
}
