import { z } from "zod";
import type { RpcResult } from "./errors";

/**
 * auth-worker の IdentityRPC が公開する DTO。
 *
 * 設計方針 (仕様書 4.1 / 4.2):
 *  - メソッドは小さく保つ。「任意の userId を受け取って無条件に情報を返す」入口を作らない。
 *  - 本人性の根拠はセッショントークンに置き、呼び出し元 Worker の申告した userId に置かない。
 *  - DTO は JSON 直列化可能な形だけを使う（日付は ISO 8601 文字列）。
 */

export const sessionTokenSchema = z
  .string()
  .min(32, "session token is too short")
  .max(512, "session token is too long");

export const userIdSchema = z.string().min(1).max(64);

// ---------------------------------------------------------------- getSession

export const getSessionInputSchema = z.object({
  sessionToken: sessionTokenSchema,
});

export type GetSessionInput = z.infer<typeof getSessionInputSchema>;

export type SessionSummary = {
  readonly userId: string;
  readonly sessionId: string;
  /** ISO 8601 (UTC) */
  readonly expiresAt: string;
};

/** セッションが無効・期限切れ・失効済みの場合は null。存在しないこと自体はエラーではない。 */
export type GetSessionResult = RpcResult<SessionSummary | null>;

// ------------------------------------------------------------ getUserProfile

export const getUserProfileInputSchema = z.object({
  /**
   * 呼び出し元が持つセッショントークン。
   * userId は受け取らない —— 受け取ると「他人の userId を指定して読む」入口になるため。
   */
  sessionToken: sessionTokenSchema,
});

export type GetUserProfileInput = z.infer<typeof getUserProfileInputSchema>;

export type UserProfile = {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly status: "active" | "suspended" | "deleted";
  readonly createdAt: string;
};

export type GetUserProfileResult = RpcResult<UserProfile | null>;

// --------------------------------------------------------------- listSessions

export const listSessionsInputSchema = z.object({
  sessionToken: sessionTokenSchema,
});

export type ListSessionsInput = z.infer<typeof listSessionsInputSchema>;

export type SessionListItem = {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  /** 現在この RPC を呼ぶのに使われたセッションかどうか。UI で「このデバイス」を示す。 */
  readonly current: boolean;
  readonly userAgent: string | null;
  readonly ipHash: string | null;
};

export type ListSessionsResult = RpcResult<readonly SessionListItem[]>;

// -------------------------------------------------------------- revokeSession

export const revokeSessionInputSchema = z.object({
  /** 操作者の本人確認に使うセッション。 */
  sessionToken: sessionTokenSchema,
  /** 失効させたいセッションの ID。操作者自身のセッションでなければ拒否される。 */
  targetSessionId: z.string().min(1).max(64),
});

export type RevokeSessionInput = z.infer<typeof revokeSessionInputSchema>;

export type RevokeSessionResult = RpcResult<{ readonly revoked: boolean }>;

// ----------------------------------------------------------------- Entrypoint

/**
 * dashboard-worker が Service Binding 越しに見る auth-worker の形。
 * auth-worker 側の `IdentityRPC` はこの型を満たす必要がある。
 */
export interface IdentityRpcContract {
  getSession(input: GetSessionInput): Promise<GetSessionResult>;
  getUserProfile(input: GetUserProfileInput): Promise<GetUserProfileResult>;
  listSessions(input: ListSessionsInput): Promise<ListSessionsResult>;
  revokeSession(input: RevokeSessionInput): Promise<RevokeSessionResult>;
}
