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
  // ipHash は載せない。dashboard-worker はこの DTO をそのままブラウザへ返すため、
  // ここに入れると IP のハッシュが利用者側へ漏れる。auth-worker 自身の
  // /api/me/sessions も返していない。必要になったら専用の管理用 RPC を分ける。
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

export type RevokeSessionResult = RpcResult<{
  readonly revoked: boolean;
  /**
   * 操作者自身のセッションを失効させたか。
   *
   * 呼び出し元はこれを見て Cookie を落とすか決める。`revoked` だけで
   * 判断すると、別端末を失効させたときに自分までログアウトされる。
   */
  readonly self: boolean;
}>;

// ----------------------------------------------------------------- listGrants

export const listGrantsInputSchema = z.object({
  /**
   * セッショントークンだけを受け取る。`userId` は受け取らない —— 同意一覧は
   * 「どのアプリに何を許可したか」という、セッション一覧と同じ機微度の情報で、
   * userId を引数にした瞬間に他人の分を読む入口になる（仕様書 4.2 の注意書き）。
   */
  sessionToken: sessionTokenSchema,
});

export type ListGrantsInput = z.infer<typeof listGrantsInputSchema>;

export type GrantListItem = {
  /**
   * OIDC の公開 `client_id`。`oauth_clients.id`（内部 ID）ではない。
   *
   * 取り消し（`revokeGrant`）の引数にもこれを使う。内部 ID を外へ出すと、
   * ダッシュボードの HTML に内部識別子が載り、以後それを受け付ける API を
   * 消せなくなる。
   */
  readonly clientId: string;
  readonly clientName: string;
  readonly logoUrl: string | null;
  /** 許可済み scope。表示のために配列で渡す（スペース区切りの再分解を各所でやらせない）。 */
  readonly scopes: readonly string[];
  /** ISO 8601 (UTC) */
  readonly grantedAt: string;
};

export type ListGrantsResult = RpcResult<readonly GrantListItem[]>;

// ---------------------------------------------------------------- revokeGrant

export const revokeGrantInputSchema = z.object({
  /** 操作者の本人確認に使うセッション。 */
  sessionToken: sessionTokenSchema,
  /** 取り消す同意の相手。公開 `client_id`。操作者自身の同意でなければ拒否される。 */
  clientId: z.string().min(1).max(255),
});

export type RevokeGrantInput = z.infer<typeof revokeGrantInputSchema>;

export type RevokeGrantResult = RpcResult<{
  /** 同意の行が「取り消し済み」へ遷移したか。既に取り消し済みなら false（冪等）。 */
  readonly revoked: boolean;
  /**
   * 巻き添えで失効した Access Token の件数。
   *
   * 「取り消しました」とだけ言われても、利用者は発行済みトークンが残って
   * いないかを確かめられない。件数を返して UI が「n 個のアクセスを停止した」と
   * 言えるようにしておく。
   */
  readonly revokedTokenCount: number;
}>;

// ----------------------------------------------------------------------- ping

/**
 * 死活確認の結果（#44）。
 *
 * **引数を取らず、個人情報も識別子も返さない。** dashboard-worker の
 * `/health` は認証されていない要求から呼ばれるので、ここに `userId` や
 * `email` が 1 つでも混じると、認証なしで読める経路になる。
 * 既存の `getSession` を health に流用しないのも同じ理由である
 * （セッションの実在が外から測れてしまう）。
 */
export type IdentityPing = {
  /** auth-worker が自分の依存先（D1）まで到達できているか。 */
  readonly status: "ok" | "degraded";
  readonly service: "u18-auth";
};

export type PingResult = RpcResult<IdentityPing>;

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
  listGrants(input: ListGrantsInput): Promise<ListGrantsResult>;
  revokeGrant(input: RevokeGrantInput): Promise<RevokeGrantResult>;
  /** 副作用の無い死活確認（#44）。認証を要求しない。 */
  ping(): Promise<PingResult>;
}
