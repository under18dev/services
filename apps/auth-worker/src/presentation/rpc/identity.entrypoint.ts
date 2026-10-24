import {
  getSessionInputSchema,
  getUserProfileInputSchema,
  listGrantsInputSchema,
  listSessionsInputSchema,
  revokeGrantInputSchema,
  revokeSessionInputSchema,
  rpcErr,
  rpcOk,
  type GetSessionInput,
  type GetSessionResult,
  type GetUserProfileInput,
  type GetUserProfileResult,
  type IdentityRpcContract,
  type ListGrantsInput,
  type ListGrantsResult,
  type ListSessionsInput,
  type ListSessionsResult,
  type PingResult,
  type RevokeGrantInput,
  type RevokeGrantResult,
  type RevokeSessionInput,
  type RevokeSessionResult,
} from "@u18/contracts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createContainer, type RequestContext } from "../../composition/container";

/**
 * dashboard-worker 等へ公開する内部 RPC（仕様書 4.2）。
 *
 * Service Binding を持つ Worker は公開 URL なしでここを呼べる。つまり
 * 「内部だから安全」ではない。各メソッドで必ず入力検証と認可を行い、
 * 呼び出し元の申告した userId は信用しない。
 */
export class IdentityRPC extends WorkerEntrypoint<Env> implements IdentityRpcContract {
  /**
   * 呼び出し元 Worker を監査ログの `actor` に載せる（#22）。
   *
   * **自己申告であって認証ではない。** Service Binding は呼び出し元の
   * 身元を運ばないので、侵害された Worker は別の Worker を名乗れる
   * （`packages/contracts` の `RPC_CALLERS`）。認可には使わない。
   *
   * 送られてこなければ `"unknown"`。契約上 optional なので、古い
   * 呼び出し元がデプロイ順の都合で残っていても壊れない。
   *
   * `ip` / `userAgent` は入れない。**RPC には発信元が無い** —— ここで
   * 分かるのは「どの Worker が呼んだか」までで、その先の利用者の IP は
   * 呼び出し元しか知らない（#122 で残した穴。埋めるなら契約に足す）。
   *
   * `waitUntil` は渡す。RPC 越しの `getSession` も、呼び出し元の応答時間に
   * そのまま乗る —— #143 で塞いだタイミング・オラクルは HTTP の入口だけ
   * だったので、ここを素通りすると dashboard 経由で同じものが観測できる。
   */
  private contextFor(caller: string | undefined): RequestContext {
    return {
      ip: null,
      userAgent: null,
      actor: caller ?? "unknown",
      waitUntil: (task) => this.ctx.waitUntil(task),
    };
  }

  async getSession(input: GetSessionInput): Promise<GetSessionResult> {
    const parsed = getSessionInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "sessionToken is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
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

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
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

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
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
      })),
    );
  }

  async revokeSession(input: RevokeSessionInput): Promise<RevokeSessionResult> {
    const parsed = revokeSessionInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
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
    return rpcOk({ revoked: result.value.revoked, self: result.value.self });
  }

  /**
   * 同意済みアプリの一覧（#18）。
   *
   * `listSessions` と同じ形。`userId` は受け取らず、セッションから導く。
   * 返すのは公開 `client_id` だけで、`oauth_clients.id`（内部 ID）は
   * `UserGrantSummary` の時点で既に落としてある。
   */
  async listGrants(input: ListGrantsInput): Promise<ListGrantsResult> {
    const parsed = listGrantsInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "sessionToken is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
    const result = await container.useCases.listGrants.execute({
      sessionToken: parsed.data.sessionToken,
    });
    if (!result.ok) return rpcErr("internal", "failed to list grants");
    if (result.value === null) return rpcErr("unauthenticated", "session is not valid");

    return rpcOk(
      result.value.map(({ grant, clientId, clientName, logoUrl }) => ({
        clientId,
        clientName,
        logoUrl,
        // Domain は `readonly string[]` を返す。DTO は構造化クローンで
        // 運ばれるので、ここで配列として素直に渡せばよい。
        scopes: [...grant.scopes],
        grantedAt: grant.grantedAt.toISOString(),
      })),
    );
  }

  /**
   * 同意を取り消す（#18）。
   *
   * **冪等ではない**。`RpcIdentityGateway` が自動リトライしないことに
   * 依存している（docs/architecture.md §5.3）。とはいえ 2 度呼ばれても
   * 壊れはしない——UseCase は取り消し済みの同意に対して
   * `revoked: false` を返し、残っているトークンがあれば掃除する。
   */
  async revokeGrant(input: RevokeGrantInput): Promise<RevokeGrantResult> {
    const parsed = revokeGrantInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
    const result = await container.useCases.revokeGrant.execute({
      sessionToken: parsed.data.sessionToken,
      clientId: parsed.data.clientId,
    });
    if (!result.ok) {
      // `revokeSession` と同じ翻訳。「同意していないクライアント」と
      // 「存在しないクライアント」は UseCase 側で既に同一視されている。
      const code = result.error.code === "unauthenticated" ? "unauthenticated" : "not_found";
      return rpcErr(code, result.error.message);
    }
    return rpcOk({
      revoked: result.value.revoked,
      revokedTokenCount: result.value.revokedTokenCount,
    });
  }
  /**
   * 副作用の無い死活確認（#44）。
   *
   * **このメソッドだけは認証を要求しない。** dashboard-worker の `/health` は
   * 認証されていない要求から呼ばれるためで、その代わりに返すのは
   * 「自分が D1 まで到達できているか」という 1 ビットだけにしてある。
   * 識別子も件数も載せない——載せた瞬間、認証なしで読める情報が増える。
   *
   * `getSession` を health に流用しないのも同じ理由。流用すると、
   * 適当なトークンを投げて応答を見ることでセッションの実在が測れてしまう。
   *
   * 例外は投げない。到達できなければ `degraded` を**値として**返し、
   * 呼び出し元が「Identity が落ちている」と「Binding が切れている」を
   * 区別できるようにする（後者は RPC 自体が throw する）。
   */
  async ping(): Promise<PingResult> {
    const container = createContainer(this.env);
    const reachable = await container.services.databaseProbe.ping();

    return rpcOk({ status: reachable ? "ok" : "degraded", service: "u18-auth" });
  }
}
