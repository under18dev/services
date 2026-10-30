import {
  closeAccountInputSchema,
  deletePasskeyInputSchema,
  getSessionInputSchema,
  getUserProfileInputSchema,
  listGrantsInputSchema,
  listPasskeysInputSchema,
  listSessionsInputSchema,
  updateProfileInputSchema,
  revokeGrantInputSchema,
  revokeSessionInputSchema,
  rpcErr,
  rpcOk,
  type CloseAccountInput,
  type CloseAccountResult,
  type DeletePasskeyInput,
  type DeletePasskeyResult,
  type GetSessionInput,
  type GetSessionResult,
  type GetUserProfileInput,
  type GetUserProfileResult,
  type IdentityRpcContract,
  type ListGrantsInput,
  type ListGrantsResult,
  type ListPasskeysInput,
  type ListPasskeysResult,
  type ListSessionsInput,
  type ListSessionsResult,
  type PingResult,
  type RevokeGrantInput,
  type RevokeGrantResult,
  type RevokeSessionInput,
  type RevokeSessionResult,
  type RpcErrorCode,
  type UpdateProfileInput,
  type UpdateProfileResult,
} from "@u18/contracts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createContainer, type RequestContext } from "../../composition/container";

/**
 * UseCase のエラーコードを RPC の語彙へ写す。
 *
 * **畳まないこと。** 以前は `revokeSession` が「`unauthenticated` か、
 * それ以外は `not_found`」という 2 値に潰していたが、更新系が増えると
 * それでは足りない —— **呼び出し元の見せ方が変わるものを 1 つにすると、
 * UI が「失敗しました」としか言えなくなる。**
 *
 * - `reauthentication_required` は「もう一度ログインすれば通る」
 * - `conflict` は「いまの状態では通らない」（username の重複、
 *   管理者の最後の Passkey）
 *
 * 知らないコードは `internal` に倒す。**`not_found` には倒さない** ——
 * 「存在しない」と言い切るのは、存在するかどうかを確かめた場合だけにする。
 */
function toRpcCode(code: string): RpcErrorCode {
  switch (code) {
    case "unauthenticated":
      return "unauthenticated";
    case "forbidden":
      return "forbidden";
    case "not_found":
      return "not_found";
    case "invalid_input":
      return "invalid_input";
    case "reauthentication_required":
      return "reauthentication_required";
    case "conflict":
      return "conflict";
    default:
      return "internal";
  }
}

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
      isAdmin: result.value.isAdmin,
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
      // **`props.isAdmin` ではない。** あれは `users` の行の旗で、
      // 「このセッションで管理者として振る舞ってよいか」ではない（決定 8 /
      // RR-5）。判定は `GetSessionUseCase` に 1 か所だけ置いてあるので、
      // ここは運ぶだけにする。
      isAdmin: session.value.isAdmin,
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
   * 自分のプロフィールを更新する（仕様書 8.1 / #11）。
   *
   * **`username` の変更には再認証が要る。** 判定は
   * `UpdateProfileUseCase` の中（`hasFreshAuthentication`）にあり、
   * HTTP のミドルウェアではない —— **経路が違っても同じ判定が効く**のは
   * そのためで、`test/rpc-parity.test.ts` が両方の入口で確かめている。
   *
   * 変えられるのは `displayName` と `username` だけ。`email` / `status` /
   * `id` は UseCase の入力型に存在しないので、ここが余計な項目を渡しても
   * 届かない。
   */
  async updateProfile(input: UpdateProfileInput): Promise<UpdateProfileResult> {
    const parsed = updateProfileInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
    const result = await container.useCases.updateProfile.execute({
      sessionToken: parsed.data.sessionToken,
      displayName: parsed.data.displayName,
      username: parsed.data.username,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    const props = result.value.user.snapshot();
    return rpcOk({
      profile: {
        id: props.id,
        username: props.username,
        displayName: props.displayName,
        email: props.email,
        emailVerified: props.emailVerified,
        status: props.status,
        createdAt: props.createdAt.toISOString(),
        // 同上。`UpdateProfileUseCase` が `GetSessionUseCase` の判定を
        // そのまま運んでくる。
        isAdmin: result.value.isAdmin,
      },
      changedFields: [...result.value.changedFields],
    });
  }

  /**
   * 登録済み Passkey の一覧（仕様書 8.1 / #75）。
   *
   * **`credentialId` と公開鍵を返さない。** 契約の `PasskeySummary` に
   * そのフィールドが無いので、ここで詰め忘れても漏れようがない
   * （`SessionListItem` から `ipHash` を外したのと同じ形。RR-13）。
   */
  async listPasskeys(input: ListPasskeysInput): Promise<ListPasskeysResult> {
    const parsed = listPasskeysInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "sessionToken is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
    const result = await container.useCases.listPasskeys.execute({
      sessionToken: parsed.data.sessionToken,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);
    if (result.value === null) return rpcErr("unauthenticated", "session is not valid");

    return rpcOk(
      result.value.map((passkey) => ({
        id: passkey.id,
        label: passkey.label,
        deviceType: passkey.deviceType,
        createdAt: passkey.createdAt.toISOString(),
        lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
      })),
    );
  }

  /**
   * Passkey を削除する（仕様書 8.1 / #75）。
   *
   * **再認証が要る。** セッションの盗用がそのまま認証器の剥奪に
   * ならないようにするため —— これが #75 の本体である。
   *
   * **管理者は最後の 1 本を削除できない**（仕様書 §14.1 決定 8）。
   * 一般利用者は削除できる（決定 2 によりメール OTP が常に残る）。
   * どちらの判定も `DeletePasskeyUseCase` の中にあるので、RPC 越しでも
   * 同じに効く。
   */
  async deletePasskey(input: DeletePasskeyInput): Promise<DeletePasskeyResult> {
    const parsed = deletePasskeyInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
    const result = await container.useCases.deletePasskey.execute({
      sessionToken: parsed.data.sessionToken,
      passkeyId: parsed.data.passkeyId,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk({ deleted: result.value.deleted, remaining: result.value.remaining });
  }

  /**
   * 本人の退会（#318 / ランブック §11.7）。
   *
   * **個人情報は落ちない。** `status` が `suspended` になりログインが
   * 塞がるだけである。`deleted` にしないのは、落とさずに立てると
   * `purgeUserSql` の `status <> 'deleted'` に弾かれ、**管理者が二度と
   * 落とせなくなる**ため。
   *
   * **再認証が要る**（`hasFreshAuthentication`）。Cookie を 1 枚持って
   * いるだけの相手に通させない。
   */
  async closeAccount(input: CloseAccountInput): Promise<CloseAccountResult> {
    const parsed = closeAccountInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
    const result = await container.useCases.closeAccount.execute({
      sessionToken: parsed.data.sessionToken,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk({
      closed: result.value.closed,
      revokedSessions: result.value.revokedSessions,
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
