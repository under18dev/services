import {
  createOAuthClientInputSchema,
  disableOAuthClientInputSchema,
  listOAuthClientsInputSchema,
  listAuditLogsInputSchema,
  listUsersInputSchema,
  reinstateUserInputSchema,
  revokeUserSessionsInputSchema,
  suspendUserInputSchema,
  rpcErr,
  rpcOk,
  type CreateOAuthClientInput,
  type CreateOAuthClientResult,
  type DisableOAuthClientInput,
  type DisableOAuthClientResult,
  type IdentityAdminRpcContract,
  type ListOAuthClientsInput,
  type ListOAuthClientsResult,
  type AuditLogEntryAdmin,
  type ListAuditLogsInput,
  type ListAuditLogsResult,
  type ListUsersInput,
  type ListUsersResult,
  type ReinstateUserInput,
  type ReinstateUserResult,
  type RevokeUserSessionsInput,
  type RevokeUserSessionsResult,
  type SuspendUserInput,
  type SuspendUserResult,
  type UserAdminSummary,
  type OAuthClientSummary,
} from "@u18/contracts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createContainer, type RequestContext } from "../../composition/container";
import type { OAuthClient } from "../../domain/entities/oauth-client";
import type { User } from "../../domain/entities/user";
import { toRpcCode } from "./identity.entrypoint";

/**
 * `OAuthClient`（Domain）を契約の DTO へ写す（#308）。
 *
 * **内部 ID（`oauth_clients.id`）を載せない。** 外へ出すと、ダッシュボードの
 * HTML に内部識別子が載り、以後それを受け付ける API を消せなくなる
 * （`GrantListItem.clientId` と同じ理由）。失効の引数も公開 `client_id` の側。
 *
 * `client_secret_hash` は**そもそも `OAuthClient` が持っていない**ので、
 * ここで落とす判断すら要らない（`DrizzleOAuthClientRepository.toDomain` が
 * 行型から写す時点で切ってある）。
 */
/**
 * `User`（Domain）を管理画面の DTO へ写す（#375）。
 *
 * **`UserProfile` へ写す関数と別に持つ。** あちらは「本人が見る自分」で、
 * `identity.entrypoint.ts` にある。同じ関数を共有すると、**本人向けに
 * 足した項目が管理画面にも自動で出る**（逆も起きる）。
 *
 * **ここが他人のメールアドレスを外へ出す唯一の場所である。** 載せる理由と、
 * 代わりに縛ったこと（URL に載せない）は契約の「利用者の管理」の節。
 *
 * **パスキーもセッションも写していない。** `User` がそもそも持っていない
 * ので、ここで落とす判断は要らない（`toClientSummary` と同じ形）。
 *
 * ## `isAdmin` という名前を使っていない
 *
 * ここが写すのは **`users.is_admin` の旗**で、「このセッションで管理者
 * として振る舞えるか」（`actsAsAdminWith`、決定 8 / RR-5）ではない。
 * 他人の行を見ているので後者は決めようがない。`vitest.config.ts` の
 * `isAdmin:` 走査（#337）が**正しくここを捕まえた**ので、名前を
 * `hasAdminFlag` に変えて意味の違いを型に出してある。
 */
function toUserAdminSummary(user: User): UserAdminSummary {
  const props = user.snapshot();
  return {
    id: props.id,
    username: props.username,
    displayName: props.displayName,
    primaryEmail: props.email,
    emailVerified: props.emailVerified,
    status: props.status,
    hasAdminFlag: props.isAdmin,
    createdAt: props.createdAt.toISOString(),
  };
}

function toClientSummary(client: OAuthClient): OAuthClientSummary {
  return {
    clientId: client.clientId,
    name: client.name,
    clientType: client.clientType,
    isFirstParty: client.isFirstParty,
    logoUrl: client.logoUrl,
    redirectUris: [...client.redirectUris],
    scopes: [...client.allowedScopes],
    createdAt: client.createdAt.toISOString(),
    disabledAt: client.disabledAt?.toISOString() ?? null,
  };
}

/**
 * OAuth クライアント管理の内部 RPC（#308）。**`IdentityRPC` とは別の入口。**
 *
 * ## なぜクラスを分けてあるか
 *
 * **Service Binding はメソッド単位で絞れない。** 束縛の単位は
 * `entrypoint` で、その Entrypoint のメソッドは全部呼べる。管理用の 3 つを
 * `IdentityRPC` に置くと、**あれを束縛している Worker は全部**呼べる
 * ことになる —— いまの束縛元は dashboard-worker と **nfc-worker** の 2 つ。
 *
 * nfc-worker は設計上**管理者のセッショントークンを扱う**（運営による
 * カード発行の可否を `SessionSummary.isAdmin` で決める。#187）。つまり
 * **管理者の新しいセッションが日常的にあの Worker を通る**うえ、
 * あちらはレート制限も `no-store` の既定化も外れている（脅威モデル N-5）。
 * 侵害されたときに「通りかかった管理者のセッションで OAuth クライアントを
 * 登録できる」状態は作らない。
 *
 * **`caller` では代えられない。** あれは自己申告で、認可には使えない
 * （仕様書 §14.1 決定 12）。`entrypoint` は Cloudflare 側で強制されるので、
 * **実際に効く境界**になる。誰がどの Entrypoint を束縛してよいかは
 * `scripts/check-service-bindings.mjs` が静的に検査する。
 *
 * ## ここでも「内部だから安全」ではない
 *
 * 束縛を持つ Worker は公開 URL なしで呼べる。**認可（管理者か）も再認証も
 * UseCase の中**にあり、この入口は入力検証と DTO への写し取りしかしない。
 * 分離はそれを二重にするものであって、置き換えるものではない。
 */
export class IdentityAdminRPC extends WorkerEntrypoint<Env> implements IdentityAdminRpcContract {
  /**
   * 呼び出し元 Worker を監査ログの `actor` に載せる。
   *
   * 中身と理由は `IdentityRPC.contextFor` と同じ（自己申告であって認証では
   * ない / RPC には発信元が無い / `waitUntil` は渡す）。**共有していない**
   * のは、`this.ctx` を閉じ込める必要があるためで、判断が 2 つあるわけでは
   * ない。
   */
  private contextFor(caller: string | undefined): RequestContext {
    return {
      ip: null,
      userAgent: null,
      actor: caller ?? "unknown",
      waitUntil: (task) => this.ctx.waitUntil(task),
    };
  }

  /**
   * OAuth クライアントの一覧（#308）。**管理者のみ。**
   *
   * **`client_secret_hash` を返さない。** 契約の `OAuthClientSummary` に
   * そのフィールドが無いうえ、`OAuthClient`（Domain）もハッシュを持たない
   * ので、ここで詰め忘れても漏れようがない（`listPasskeys` と同じ形。RR-13）。
   *
   * 管理者でないセッションは `not_found` になる。判定は UseCase の中なので、
   * この入口を迂回しても同じに効く。
   */
  async listOAuthClients(input: ListOAuthClientsInput): Promise<ListOAuthClientsResult> {
    const parsed = listOAuthClientsInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "sessionToken is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
    const result = await container.useCases.listOAuthClients.execute({
      sessionToken: parsed.data.sessionToken,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk(result.value.map(toClientSummary));
  }

  /**
   * OAuth クライアントを登録する（#308）。**管理者のみ。**
   *
   * **平文の `client_secret` はこの応答にしか現れない。** DB に入るのは
   * ハッシュだけで、取り損ねたら再発行するしかない（`oauth-client.mjs` が
   * 端末へ 1 度だけ出しているのと同じ性質）。
   *
   * **再認証が要る**（`reauthentication_required`）。決めているのは
   * 認可コードの宛先なので、盗んだ Cookie 1 枚で通ってよい操作ではない
   * —— 通ると Redirect URI の完全一致検証を**登録の側から迂回**できる。
   * 判定は UseCase の中なので、RPC 越しでも同じに効く
   * （`deletePasskey` と同じ形。`test/rpc-parity.test.ts`）。
   *
   * **`is_first_party` は指定できない。** 契約の入力に項目が無く、
   * 登録されるクライアントは必ず同意画面を出す。一次パーティの登録は
   * `scripts/oauth-client.mjs --first-party` だけに残っている（RR-21）。
   *
   * `redirect_uri` の検証も `client_id` の重複判定も UseCase の中にある。
   * **ここで先に弾かない** —— 入口ごとに判定を書くと、CLI で通した URI が
   * 認可時に弾かれる形のずれが起きる。
   */
  async createOAuthClient(input: CreateOAuthClientInput): Promise<CreateOAuthClientResult> {
    const parsed = createOAuthClientInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
    const result = await container.useCases.createOAuthClient.execute({
      sessionToken: parsed.data.sessionToken,
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

  /**
   * OAuth クライアントを失効させる（#308）。**管理者のみ。**冪等。
   *
   * 2 度目は `disabled: false` になり、最初の `disabled_at` は動かない。
   * 未登録の `client_id` も同じ応答になる（登録済みかを総当たりで
   * 調べさせない）。**登録と同じく再認証が要る** —— 失効は正規の
   * クライアントを黙って止める手口でもある。
   *
   * **発行済みの Access Token は止まらない。** 止まるのは以後の認可だけで、
   * いま動いているアクセスを切るには `revokeGrant` が要る
   * （`DisableOAuthClientUseCase` の JSDoc）。呼び出し元は
   * 「アクセスを停止しました」と書かないこと。
   */
  async disableOAuthClient(input: DisableOAuthClientInput): Promise<DisableOAuthClientResult> {
    const parsed = disableOAuthClientInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
    const result = await container.useCases.disableOAuthClient.execute({
      sessionToken: parsed.data.sessionToken,
      clientId: parsed.data.clientId,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk({ disabled: result.value.disabled });
  }

  /**
   * 利用者の一覧（#375）。**管理者のみ。**
   *
   * **他人を指す最初のメソッドである。** これまでは `sessionToken` が
   * 誰を指すかを auth-worker が決めており、呼ぶ側は対象を選べなかった。
   *
   * **再認証を要求していない。** 読み取りだけで状態を変えないので
   * `listOAuthClients` と同じ扱いにしてある。凍結やセッションの失効を
   * 足すときは、**そちらに `hasFreshAuthentication` を付けること。**
   *
   * 管理者でないセッションは `not_found` になる。判定は UseCase の中。
   */
  async listUsers(input: ListUsersInput): Promise<ListUsersResult> {
    const parsed = listUsersInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
    const result = await container.useCases.listUsers.execute({
      sessionToken: parsed.data.sessionToken,
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

  /**
   * 利用者を停止する（#375）。**管理者のみ。再認証が要る。**
   *
   * **理由は `audit_logs` にしか残らない。** `status` は `suspended` の
   * 1 値で、本人の退会（#318）とも同じ値になる。
   */
  async suspendUser(input: SuspendUserInput): Promise<SuspendUserResult> {
    const parsed = suspendUserInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
    const result = await container.useCases.manageUser.suspend({
      sessionToken: parsed.data.sessionToken,
      userId: parsed.data.userId,
      reason: parsed.data.reason,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk({ revokedSessions: result.value.revokedSessions });
  }

  /** 停止を解除する（#375）。**`deleted` は戻せない**（`conflict`）。 */
  async reinstateUser(input: ReinstateUserInput): Promise<ReinstateUserResult> {
    const parsed = reinstateUserInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
    const result = await container.useCases.manageUser.reinstate({
      sessionToken: parsed.data.sessionToken,
      userId: parsed.data.userId,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk({});
  }

  /** セッションを全部切る（#375）。**停止とは別の操作。** */
  async revokeUserSessions(input: RevokeUserSessionsInput): Promise<RevokeUserSessionsResult> {
    const parsed = revokeUserSessionsInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
    const result = await container.useCases.manageUser.revokeSessions({
      sessionToken: parsed.data.sessionToken,
      userId: parsed.data.userId,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.error.code), result.error.message);

    return rpcOk({ revokedSessions: result.value.revokedSessions });
  }

  /**
   * 監査ログの閲覧（#375）。**管理者のみ。**
   *
   * `metadata` はそのまま返す。秘密を含まないことは書き込み側
   * （`AuditEvent` の JSDoc / `test/audit-secrets.test.ts`）が保証している。
   */
  async listAuditLogs(input: ListAuditLogsInput): Promise<ListAuditLogsResult> {
    const parsed = listAuditLogsInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "input is malformed");

    const container = createContainer(this.env, {}, this.contextFor(parsed.data.caller));
    const result = await container.useCases.listAuditLogs.execute({
      sessionToken: parsed.data.sessionToken,
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

/** `PersistedAuditLogEntry`（Domain 寄りの読み取り行）を契約の DTO へ写す（#375）。 */
function toAuditLogEntryAdmin(entry: {
  readonly id: string;
  readonly event: string;
  readonly userId: string | null;
  readonly actor: string | null;
  readonly outcome: "success" | "failure";
  readonly reason: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly ipHash: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
}): AuditLogEntryAdmin {
  return {
    id: entry.id,
    event: entry.event,
    userId: entry.userId,
    actor: entry.actor,
    outcome: entry.outcome,
    reason: entry.reason,
    metadata: entry.metadata,
    ipHash: entry.ipHash,
    userAgent: entry.userAgent,
    createdAt: entry.createdAt.toISOString(),
  };
}
