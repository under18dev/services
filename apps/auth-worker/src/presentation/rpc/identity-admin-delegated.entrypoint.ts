import {
  createOAuthClientDelegatedInputSchema,
  disableOAuthClientDelegatedInputSchema,
  listAuditLogsDelegatedInputSchema,
  listOAuthClientsDelegatedInputSchema,
  listUsersDelegatedInputSchema,
  reinstateUserDelegatedInputSchema,
  revokeUserSessionsDelegatedInputSchema,
  rpcErr,
  rpcOk,
  suspendUserDelegatedInputSchema,
  type CreateOAuthClientDelegatedInput,
  type CreateOAuthClientDelegatedResult,
  type DisableOAuthClientDelegatedInput,
  type DisableOAuthClientDelegatedResult,
  type IdentityAdminDelegatedRpcContract,
  type ListAuditLogsDelegatedInput,
  type ListAuditLogsDelegatedResult,
  type ListOAuthClientsDelegatedInput,
  type ListOAuthClientsDelegatedResult,
  type ListUsersDelegatedInput,
  type ListUsersDelegatedResult,
  type ReinstateUserDelegatedInput,
  type ReinstateUserDelegatedResult,
  type RevokeUserSessionsDelegatedInput,
  type RevokeUserSessionsDelegatedResult,
  type SuspendUserDelegatedInput,
  type SuspendUserDelegatedResult,
} from "@u18/contracts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createContainer, type RequestContext } from "../../composition/container";
import { toRpcCode } from "./identity.entrypoint";
import {
  toAuditLogEntryAdmin,
  toClientSummary,
  toUserAdminSummary,
} from "./identity-admin.entrypoint";

/**
 * admin-worker から呼べる内部 RPC（#390 決定 16 ③）。
 *
 * ## `IdentityAdminRPC` とは別の仕組みである
 *
 * `IdentityAdminRpcContract`（dashboard-worker 向け、`sessionToken` 必須）
 * はそのまま残す。**#390 の段取り 6 で dashboard-worker の移行が終わるまで、
 * 2 つの入口が並走する。** 移行が終わったら `IdentityAdminRPC` ごと消え、
 * `IdentityAdminDelegatedRPC` だけが残る（RR-21 の緩和 (7) 参照）。
 *
 * ## trust boundary は Service Binding そのものである
 *
 * **ここでは `actorUserId` を認可には使わない。** 検証するのは実在だけ
 * （`requireExistingActor`）。この Entrypoint へ辿り着けること自体が
 * Service Binding で保証されており、admin-worker は呼ぶ前に自分の
 * 承認リストで管理者性を確かめている。二重に確かめる理由が無い
 * （`IdentityAdminDelegatedRpcContract` の冒頭、nfc-worker の
 * `NfcAdminDelegatedRPC` と同じ設計）。
 *
 * **この Entrypoint を束縛してよいのは admin-worker だけである。**
 * `scripts/check-service-bindings.mjs` が静的に検査する対象になる
 * （admin-worker が実際に束縛する PR で `ALLOWED_ENTRYPOINT_CONSUMERS`
 * に足すこと。いまは束縛が実在しないので検査対象に入っていない）。
 *
 * ## UseCase は既存と別クラスにしてある
 *
 * `ListUsersUseCase` 等をそのまま呼ばず、`Delegated*UseCase` を新設した。
 * 共有しているのは Repository・Domain の純粋関数（検証ロジックなど）で、
 * 「管理者のセッションを確かめる」部分だけが無い。`NfcAdminDelegatedRPC`
 * が `AdminDisableCardUseCase` と `DelegatedDisableCardUseCase` を
 * 分けたのと同じ形（94 の実装、d5 のレビュー済み）。
 */
export class IdentityAdminDelegatedRPC
  extends WorkerEntrypoint<Env>
  implements IdentityAdminDelegatedRpcContract
{
  /**
   * 監査ログの `actor` に載せる固定値。
   *
   * **`caller` のような入力ではなく、ハードコードした定数である。**
   * この Entrypoint を束縛できるのは admin-worker だけなので、
   * 自己申告させても値は常に 1 種類にしかならない（契約の JSDoc 「`caller`
   * を持たない」を参照）。それでも `audit_logs.actor` を空のままにしない
   * のは、調査するときに「この行は delegated 経由である」と読めたほうが
   * 親切だからである。
   */
  private context(): RequestContext {
    return {
      ip: null,
      userAgent: null,
      actor: "admin-worker",
      waitUntil: (task) => this.ctx.waitUntil(task),
    };
  }

  async listUsers(input: ListUsersDelegatedInput): Promise<ListUsersDelegatedResult> {
    const parsed = listUsersDelegatedInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.context());
    const result = await container.useCases.delegatedListUsers.execute({
      ...(parsed.data.query === undefined ? {} : { query: parsed.data.query }),
      ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
      ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk({
      users: result.value.users.map(toUserAdminSummary),
      nextCursor: result.value.nextCursor,
    });
  }

  async suspendUser(input: SuspendUserDelegatedInput): Promise<SuspendUserDelegatedResult> {
    const parsed = suspendUserDelegatedInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.context());
    const result = await container.useCases.delegatedManageUser.suspend({
      actorUserId: parsed.data.actorUserId,
      userId: parsed.data.userId,
      reason: parsed.data.reason,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk({ revokedSessions: result.value.revokedSessions });
  }

  async reinstateUser(input: ReinstateUserDelegatedInput): Promise<ReinstateUserDelegatedResult> {
    const parsed = reinstateUserDelegatedInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.context());
    const result = await container.useCases.delegatedManageUser.reinstate({
      actorUserId: parsed.data.actorUserId,
      userId: parsed.data.userId,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk({});
  }

  async revokeUserSessions(
    input: RevokeUserSessionsDelegatedInput,
  ): Promise<RevokeUserSessionsDelegatedResult> {
    const parsed = revokeUserSessionsDelegatedInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.context());
    const result = await container.useCases.delegatedManageUser.revokeSessions({
      actorUserId: parsed.data.actorUserId,
      userId: parsed.data.userId,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk({ revokedSessions: result.value.revokedSessions });
  }

  async listOAuthClients(
    input: ListOAuthClientsDelegatedInput,
  ): Promise<ListOAuthClientsDelegatedResult> {
    const parsed = listOAuthClientsDelegatedInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.context());
    const result = await container.useCases.delegatedListOAuthClients.execute();
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk(result.value.map(toClientSummary));
  }

  async createOAuthClient(
    input: CreateOAuthClientDelegatedInput,
  ): Promise<CreateOAuthClientDelegatedResult> {
    const parsed = createOAuthClientDelegatedInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.context());
    const result = await container.useCases.delegatedCreateOAuthClient.execute({
      actorUserId: parsed.data.actorUserId,
      name: parsed.data.name,
      clientType: parsed.data.clientType,
      redirectUris: parsed.data.redirectUris,
      scopes: parsed.data.scopes,
      logoUrl: parsed.data.logoUrl,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk({
      client: toClientSummary(result.value.client),
      clientSecret: result.value.clientSecret,
    });
  }

  async disableOAuthClient(
    input: DisableOAuthClientDelegatedInput,
  ): Promise<DisableOAuthClientDelegatedResult> {
    const parsed = disableOAuthClientDelegatedInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.context());
    const result = await container.useCases.delegatedDisableOAuthClient.execute({
      actorUserId: parsed.data.actorUserId,
      clientId: parsed.data.clientId,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk({ disabled: result.value.disabled });
  }

  async listAuditLogs(input: ListAuditLogsDelegatedInput): Promise<ListAuditLogsDelegatedResult> {
    const parsed = listAuditLogsDelegatedInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.context());
    const result = await container.useCases.delegatedListAuditLogs.execute({
      ...(parsed.data.event === undefined ? {} : { event: parsed.data.event }),
      ...(parsed.data.userId === undefined ? {} : { userId: parsed.data.userId }),
      ...(parsed.data.outcome === undefined ? {} : { outcome: parsed.data.outcome }),
      ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
      ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk({
      entries: result.value.entries.map(toAuditLogEntryAdmin),
      nextCursor: result.value.nextCursor,
    });
  }
}
