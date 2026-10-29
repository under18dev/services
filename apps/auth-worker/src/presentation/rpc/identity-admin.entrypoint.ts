import {
  createOAuthClientInputSchema,
  disableOAuthClientInputSchema,
  listOAuthClientsInputSchema,
  rpcErr,
  rpcOk,
  type CreateOAuthClientInput,
  type CreateOAuthClientResult,
  type DisableOAuthClientInput,
  type DisableOAuthClientResult,
  type IdentityAdminRpcContract,
  type ListOAuthClientsInput,
  type ListOAuthClientsResult,
  type OAuthClientSummary,
} from "@u18/contracts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createContainer, type RequestContext } from "../../composition/container";
import type { OAuthClient } from "../../domain/entities/oauth-client";
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
      clientId: parsed.data.clientId,
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
}
