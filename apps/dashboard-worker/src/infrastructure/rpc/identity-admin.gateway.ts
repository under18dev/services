import type { IdentityAdminRpcContract, RpcCaller, RpcResult, SuspendReason } from "@u18/contracts";
import type { IdentityAdminGateway, IdentityOutcome } from "../../application/ports";
import { toFailure } from "./identity.gateway";

/**
 * 管理用 Entrypoint のスタブを契約インターフェースとして見る。
 *
 * **`asIdentityRpc` と別に置く。** 同じ関数で両方を扱えるようにすると、
 * `env.IDENTITY` を渡して管理用の契約として読む、という取り違えが
 * **型で止まらなくなる。** 束縛が 2 本ある意味が、ここで 1 本に戻る。
 */
export function asIdentityAdminRpc(binding: Fetcher): IdentityAdminRpcContract {
  return binding as unknown as IdentityAdminRpcContract;
}

/**
 * Service Binding 経由で auth-worker の `IdentityAdminRPC` を呼ぶ adapter。
 *
 * **失敗の翻訳は `identity.gateway.ts` の `toFailure` を共有する。**
 * 2 本持つと、`not_found` の扱いが片方だけずれる形が作れる ——
 * 管理領域で `not_found` は「権限が無い」を畳んだ値なので、**ずれた側は
 * 画面に『そんなクライアントはありません』と出す。**
 *
 * **冪等でない `createOAuthClient` を自動リトライしないこと。** 2 回
 * 通ると `client_secret` が 2 つ生まれ、画面に出るのは後の 1 つになる。
 */
export class RpcIdentityAdminGateway implements IdentityAdminGateway {
  constructor(private readonly admin: IdentityAdminRpcContract) {}

  /** 監査ログの `actor`。`RpcIdentityGateway` と同じ理由で全呼び出しに付ける。 */
  private static readonly CALLER = "dashboard-worker" as const satisfies RpcCaller;

  private input<T extends object>(fields: T): T & { caller: RpcCaller } {
    return { ...fields, caller: RpcIdentityAdminGateway.CALLER };
  }

  listOAuthClients(sessionToken: string) {
    return this.call(() => this.admin.listOAuthClients(this.input({ sessionToken })));
  }

  createOAuthClient(
    sessionToken: string,
    input: {
      readonly clientId: string;
      readonly name: string;
      readonly clientType: "confidential" | "public";
      readonly redirectUris: readonly string[];
      readonly scopes?: readonly string[];
      readonly logoUrl?: string | null;
    },
  ) {
    return this.call(() =>
      this.admin.createOAuthClient(
        this.input({
          sessionToken,
          clientId: input.clientId,
          name: input.name,
          clientType: input.clientType,
          // **`readonly` を外すためだけに複製している。** 契約は zod から
          // 型を導いており、あちらの配列は mutable である。Port 側を
          // mutable にすると、呼ぶ側が渡した配列を adapter が書き換え
          // うる形になる —— 複製するほうを選ぶ。
          redirectUris: [...input.redirectUris],
          ...(input.scopes === undefined ? {} : { scopes: [...input.scopes] }),
          ...(input.logoUrl === undefined ? {} : { logoUrl: input.logoUrl }),
        }),
      ),
    );
  }

  disableOAuthClient(sessionToken: string, clientId: string) {
    return this.call(() => this.admin.disableOAuthClient(this.input({ sessionToken, clientId })));
  }

  suspendUser(sessionToken: string, userId: string, reason: SuspendReason) {
    return this.call(() => this.admin.suspendUser(this.input({ sessionToken, userId, reason })));
  }

  reinstateUser(sessionToken: string, userId: string) {
    return this.call(() => this.admin.reinstateUser(this.input({ sessionToken, userId })));
  }

  revokeUserSessions(sessionToken: string, userId: string) {
    return this.call(() => this.admin.revokeUserSessions(this.input({ sessionToken, userId })));
  }

  listAuditLogs(
    sessionToken: string,
    criteria: {
      readonly event?: string;
      readonly userId?: string;
      readonly outcome?: "success" | "failure";
      readonly cursor?: string;
    },
  ) {
    return this.call(() =>
      this.admin.listAuditLogs(
        this.input({
          sessionToken,
          ...(criteria.event === undefined || criteria.event === ""
            ? {}
            : { event: criteria.event }),
          ...(criteria.userId === undefined || criteria.userId === ""
            ? {}
            : { userId: criteria.userId }),
          ...(criteria.outcome === undefined ? {} : { outcome: criteria.outcome }),
          ...(criteria.cursor === undefined || criteria.cursor === ""
            ? {}
            : { cursor: criteria.cursor }),
        }),
      ),
    );
  }

  listUsers(sessionToken: string, criteria: { readonly query?: string; readonly cursor?: string }) {
    return this.call(() =>
      this.admin.listUsers(
        this.input({
          sessionToken,
          // **空文字を渡さない。** 契約の `min(1)` に落ちて
          // `invalid_input` になり、画面には「障害」として出る。
          ...(criteria.query === undefined || criteria.query === ""
            ? {}
            : { query: criteria.query }),
          ...(criteria.cursor === undefined || criteria.cursor === ""
            ? {}
            : { cursor: criteria.cursor }),
        }),
      ),
    );
  }

  /**
   * `RpcIdentityGateway.call` と同じ形。
   *
   * **例外は「Identity が使えない」へ畳む。** 管理領域だけ throw を
   * 素通しにすると、Presentation が 500 以外を選べなくなる。
   */
  private async call<T>(invoke: () => Promise<RpcResult<T>>): Promise<IdentityOutcome<T>> {
    try {
      const result = await invoke();
      if (result.ok) return { ok: true, value: result.value };
      return { ok: false, failure: toFailure(result.error) };
    } catch (cause) {
      console.error("identity admin rpc call failed", cause);
      return {
        ok: false,
        failure: { kind: "identity_unavailable", detail: "identity service unreachable" },
      };
    }
  }
}
