import {
  getSessionInputSchema,
  getUserProfileInputSchema,
  listSessionsInputSchema,
  revokeSessionInputSchema,
  rpcErr,
  rpcOk,
  type GetSessionInput,
  type GetSessionResult,
  type GetUserProfileInput,
  type GetUserProfileResult,
  type IdentityRpcContract,
  type ListSessionsInput,
  type ListSessionsResult,
  type RevokeSessionInput,
  type RevokeSessionResult,
} from "@u18/contracts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createContainer } from "../../composition/container";

/**
 * dashboard-worker 等へ公開する内部 RPC（仕様書 4.2）。
 *
 * Service Binding を持つ Worker は公開 URL なしでここを呼べる。つまり
 * 「内部だから安全」ではない。各メソッドで必ず入力検証と認可を行い、
 * 呼び出し元の申告した userId は信用しない。
 */
export class IdentityRPC extends WorkerEntrypoint<Env> implements IdentityRpcContract {
  async getSession(input: GetSessionInput): Promise<GetSessionResult> {
    const parsed = getSessionInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "sessionToken is malformed");

    const container = createContainer(this.env);
    const result = await container.useCases.getSession.execute({
      sessionToken: parsed.data.sessionToken,
    });
    if (!result.ok) return rpcErr("internal", "failed to resolve session");
    if (result.value === null) return rpcOk(null);

    const { session } = result.value;
    return rpcOk({
      userId: session.userId,
      sessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
    });
  }

  async getUserProfile(input: GetUserProfileInput): Promise<GetUserProfileResult> {
    const parsed = getUserProfileInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "sessionToken is malformed");

    const container = createContainer(this.env);
    const session = await container.useCases.getSession.execute({
      sessionToken: parsed.data.sessionToken,
    });
    if (!session.ok) return rpcErr("internal", "failed to resolve session");
    if (session.value === null) return rpcOk(null);

    // userId はセッションから導く。呼び出し元が指定した ID では引かない。
    const user = await container.repositories.users.findById(session.value.userId);
    if (user === null) return rpcOk(null);

    const props = user.snapshot();
    return rpcOk({
      id: props.id,
      username: props.username,
      displayName: props.displayName,
      email: props.email,
      emailVerified: props.emailVerified,
      status: props.status,
      createdAt: props.createdAt.toISOString(),
    });
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    const parsed = listSessionsInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "sessionToken is malformed");

    const container = createContainer(this.env);
    const result = await container.useCases.listSessions.execute({
      sessionToken: parsed.data.sessionToken,
    });
    if (!result.ok) return rpcErr("internal", "failed to list sessions");
    if (result.value === null) return rpcErr("unauthenticated", "session is not valid");

    return rpcOk(
      result.value.map(({ session, current }) => ({
        sessionId: session.id,
        current,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        userAgent: session.userAgent,
        ipHash: session.ipHash,
      })),
    );
  }

  async revokeSession(input: RevokeSessionInput): Promise<RevokeSessionResult> {
    const parsed = revokeSessionInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env);
    const result = await container.useCases.revokeSession.execute({
      sessionToken: parsed.data.sessionToken,
      targetSessionId: parsed.data.targetSessionId,
    });
    if (!result.ok) {
      // UseCase のエラーコードをそのまま契約のコードへ写す。
      // 「他人のセッション」と「存在しない」は UseCase 側で既に同一視されている。
      const code = result.error.code === "unauthenticated" ? "unauthenticated" : "not_found";
      return rpcErr(code, result.error.message);
    }
    return rpcOk({ revoked: result.value.revoked });
  }
}
