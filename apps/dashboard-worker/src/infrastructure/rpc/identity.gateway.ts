import type { IdentityRpcContract, RpcError, RpcResult } from "@u18/contracts";
import type { IdentityGateway, IdentityOutcome } from "../../application/ports";
import type { IdentityFailure } from "../../domain/errors";

/** RPC のエラー契約を、この Worker のドメイン語彙へ翻訳する。 */
function toFailure(error: RpcError): IdentityFailure {
  switch (error.code) {
    case "unauthenticated":
      return { kind: "unauthenticated" };
    case "forbidden":
      return { kind: "forbidden" };
    case "not_found":
      return { kind: "not_found" };
    case "invalid_input":
      // 入力の組み立てはこちらの責任なので、ユーザーには障害として見せる。
      return { kind: "identity_unavailable", detail: "invalid request to identity service" };
    case "rate_limited":
      return { kind: "identity_unavailable", detail: "identity service is rate limiting" };
    default:
      return { kind: "identity_unavailable", detail: "identity service error" };
  }
}

/**
 * Service Binding 経由で auth-worker を呼ぶ adapter。
 *
 * RPC の失敗・タイムアウトをここで明示的に扱う（仕様書 4.4）。
 * 冪等でない操作（revokeSession）を自動リトライしないこと。
 */
export class RpcIdentityGateway implements IdentityGateway {
  constructor(private readonly identity: Service<IdentityRpcContract>) {}

  getSession(sessionToken: string) {
    return this.call(() => this.identity.getSession({ sessionToken }));
  }

  getProfile(sessionToken: string) {
    return this.call(() => this.identity.getUserProfile({ sessionToken }));
  }

  listSessions(sessionToken: string) {
    return this.call(() => this.identity.listSessions({ sessionToken }));
  }

  revokeSession(sessionToken: string, targetSessionId: string) {
    return this.call(() => this.identity.revokeSession({ sessionToken, targetSessionId }));
  }

  /**
   * RPC 共通の呼び出し。
   *
   * 投げられた例外（Worker の停止・デプロイ中の不整合など）は
   * 「Identity が使えない」に畳み込む。ここで throw を素通しすると、
   * Presentation 層が 500 以外の扱いを選べなくなる。
   */
  private async call<T>(invoke: () => Promise<RpcResult<T>>): Promise<IdentityOutcome<T>> {
    try {
      const result = await invoke();
      if (result.ok) return { ok: true, value: result.value };
      return { ok: false, failure: toFailure(result.error) };
    } catch (cause) {
      console.error("identity rpc call failed", cause);
      return {
        ok: false,
        failure: { kind: "identity_unavailable", detail: "identity service unreachable" },
      };
    }
  }
}
