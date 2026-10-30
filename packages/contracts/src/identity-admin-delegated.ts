import { z } from "zod";
import type { AuditLogEntryAdmin, OAuthClientSummary, UserAdminSummary } from "./identity-admin";
import { suspendReasonSchema } from "./identity-admin";
import type { RpcResult } from "./errors";

/**
 * auth-worker の **`IdentityAdminDelegatedRPC`** が公開する DTO
 * （#390 決定 16 ③）。
 *
 * ## なぜ `IdentityAdminRpcContract` と別にしてあるか
 *
 * admin-worker は OIDC で admin-worker 自身にログインし、admin-worker
 * 独自の承認リストで管理者性を確認している。**auth-worker のセッション
 * Cookie を持たない**ので、既存の管理 API（`sessionToken` 必須）を
 * そのまま呼べない。nfc-worker の `NfcAdminDelegatedRpcContract`
 * （#382 / #390 決定 16 ③）と同じ形をここにも用意する。
 *
 * ## trust boundary は Service Binding そのものである
 *
 * **ここに届く `actorUserId` を認可には使わない。** この Entrypoint へ
 * 辿り着けること自体が Service Binding で保証されており
 * （`scripts/check-service-bindings.mjs`）、束縛できるのは admin-worker
 * だけである。admin-worker は呼ぶ前に自分の承認リストで管理者性を
 * 確かめている —— 二重に確かめる理由が無い（運用者の判断：権限判定は
 * admin-worker 側へ全面移行、2026-10-30）。
 *
 * **`actorUserId` は admin-worker が申告する ID Token の `sub`。**
 * auth-worker は実在だけを確かめ（`requireExistingActor`）、本人性の
 * 検証はしていない —— **admin-worker 自身の承認リストの正しさに依存する。**
 * `docs/threat-model.md` の該当節に同じ注記がある。
 *
 * ## `caller` を持たない
 *
 * **`IdentityAdminRpcContract` と違う点。** `caller` が監査に効くのは
 * 「同じ Entrypoint を複数の Worker が束縛しうるとき」で、`actor` を見れば
 * どちらから来たログか分かる場合である。**delegated 系は束縛表そのものが
 * 「admin-worker 専用」を強制する**ので、`caller` の値は常に 1 種類にしか
 * ならない。1 種類しか取らない値を持たせても、冗長な列が増えるだけである
 * （`NfcAdminDelegatedRpcContract` と同じ判断。94 の指摘）。
 *
 * ## 既存の結果型をそのまま使う
 *
 * `UserAdminSummary` / `OAuthClientSummary` / `AuditLogEntryAdmin` は
 * `identity-admin.ts` のものを再利用する。**出力の形は入口が変わっても
 * 変わらない** —— 変わるのは「誰が呼んでよいか」の確かめ方だけである。
 */

// ----------------------------------------------------------------- listUsers

export const listUsersDelegatedInputSchema = z.object({
  /** admin-worker が確認済みの、操作者（運営）の userId。実在だけ確かめる。 */
  actorUserId: z.string().min(1),
  query: z.string().min(1).max(320).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ListUsersDelegatedInput = z.infer<typeof listUsersDelegatedInputSchema>;
export type ListUsersDelegatedResult = RpcResult<{
  readonly users: readonly UserAdminSummary[];
  readonly nextCursor: string | null;
}>;

// ------------------------------------------------------------- suspendUser

export const suspendUserDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  userId: z.string().min(1).max(64),
  reason: suspendReasonSchema,
});
export type SuspendUserDelegatedInput = z.infer<typeof suspendUserDelegatedInputSchema>;
export type SuspendUserDelegatedResult = RpcResult<{ readonly revokedSessions: number }>;

// ------------------------------------------------------------ reinstateUser

export const reinstateUserDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  userId: z.string().min(1).max(64),
});
export type ReinstateUserDelegatedInput = z.infer<typeof reinstateUserDelegatedInputSchema>;
export type ReinstateUserDelegatedResult = RpcResult<Record<string, never>>;

// ------------------------------------------------------ revokeUserSessions

export const revokeUserSessionsDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  userId: z.string().min(1).max(64),
});
export type RevokeUserSessionsDelegatedInput = z.infer<
  typeof revokeUserSessionsDelegatedInputSchema
>;
export type RevokeUserSessionsDelegatedResult = RpcResult<{ readonly revokedSessions: number }>;

// -------------------------------------------------------- listOAuthClients

export const listOAuthClientsDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
});
export type ListOAuthClientsDelegatedInput = z.infer<typeof listOAuthClientsDelegatedInputSchema>;
export type ListOAuthClientsDelegatedResult = RpcResult<readonly OAuthClientSummary[]>;

// ------------------------------------------------------- createOAuthClient

export const createOAuthClientDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  /**
   * **呼び出し元から受け取る。** `IdentityAdminRpcContract` 側は自動生成に
   * 変わったが（#408）、admin-worker の画面がまだ無いので、同じ判断を
   * 先回りしない。画面が固まったら、同じ判断（自動生成するか）をここでも
   * 下すこと。
   */
  clientId: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  clientType: z.enum(["confidential", "public"]),
  redirectUris: z.array(z.string().min(1).max(2048)).min(1).max(16),
  scopes: z.array(z.string().min(1).max(64)).min(1).max(16).optional(),
  logoUrl: z.string().max(2048).nullable().optional(),
});
export type CreateOAuthClientDelegatedInput = z.infer<typeof createOAuthClientDelegatedInputSchema>;
export type CreateOAuthClientDelegatedResult = RpcResult<{
  readonly client: OAuthClientSummary;
  readonly clientSecret: string | null;
}>;

// ------------------------------------------------------ disableOAuthClient

export const disableOAuthClientDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  clientId: z.string().min(1).max(255),
});
export type DisableOAuthClientDelegatedInput = z.infer<
  typeof disableOAuthClientDelegatedInputSchema
>;
export type DisableOAuthClientDelegatedResult = RpcResult<{ readonly disabled: boolean }>;

// ---------------------------------------------------------- listAuditLogs

export const listAuditLogsDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  event: z.string().min(1).max(64).optional(),
  userId: z.string().min(1).max(64).optional(),
  outcome: z.enum(["success", "failure"]).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ListAuditLogsDelegatedInput = z.infer<typeof listAuditLogsDelegatedInputSchema>;
export type ListAuditLogsDelegatedResult = RpcResult<{
  readonly entries: readonly AuditLogEntryAdmin[];
  readonly nextCursor: string | null;
}>;

/**
 * `IdentityAdminDelegatedRPC` の契約。
 *
 * **メソッドが増えるたびに、ここと Entrypoint の両方を変えること。**
 * Service Binding はメソッド単位で絞れないので、この Entrypoint を
 * 束縛した Worker は定義した全メソッドを呼べる —— 束縛先は admin-worker
 * だけにすること（`scripts/check-service-bindings.mjs`）。
 */
export interface IdentityAdminDelegatedRpcContract {
  listUsers(input: ListUsersDelegatedInput): Promise<ListUsersDelegatedResult>;
  suspendUser(input: SuspendUserDelegatedInput): Promise<SuspendUserDelegatedResult>;
  reinstateUser(input: ReinstateUserDelegatedInput): Promise<ReinstateUserDelegatedResult>;
  revokeUserSessions(
    input: RevokeUserSessionsDelegatedInput,
  ): Promise<RevokeUserSessionsDelegatedResult>;
  listOAuthClients(input: ListOAuthClientsDelegatedInput): Promise<ListOAuthClientsDelegatedResult>;
  createOAuthClient(
    input: CreateOAuthClientDelegatedInput,
  ): Promise<CreateOAuthClientDelegatedResult>;
  disableOAuthClient(
    input: DisableOAuthClientDelegatedInput,
  ): Promise<DisableOAuthClientDelegatedResult>;
  listAuditLogs(input: ListAuditLogsDelegatedInput): Promise<ListAuditLogsDelegatedResult>;
}
