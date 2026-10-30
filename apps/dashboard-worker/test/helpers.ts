import type { IdentityAdminRpcContract, IdentityRpcContract } from "@u18/contracts";

/**
 * `IdentityRpcContract` の fake を仕込んだ `Env` を作る。
 *
 * dashboard-worker は `c.env.IDENTITY` を `asIdentityRpc()` で契約として
 * 見るだけなので、Service Binding の実体は要らない。ここに差し込めば
 * `RpcIdentityGateway` の翻訳まで含めて HTTP 層を検証できる。
 *
 * 本物の auth-worker と繋ぐのは統合テスト (`tests/e2e/`) の仕事。
 */
export function envWith(
  identity: Partial<IdentityRpcContract>,
  environment: string = "development",
  /**
   * 管理用 Entrypoint の偽物（#333）。
   *
   * **既定は「何も実装していない」** —— 呼ぶと
   * `TypeError: ... is not a function` になり、`RpcIdentityAdminGateway`
   * がそれを `identity_unavailable` へ畳む。管理画面を見ないテストは
   * 渡さなくてよい。
   *
   * **`identity` を流用しない。** 流用すると、本番で分けてある 2 本の
   * binding がテストの中だけ 1 本になり、**`IDENTITY` に管理用の
   * メソッドを生やしても誰も気づかない**（境界が消えたことが
   * テストから見えなくなる）。
   */
  identityAdmin: Partial<IdentityAdminRpcContract> = {},
): Env {
  return {
    ENVIRONMENT: environment,
    AUTH_ISSUER: "http://localhost:8787",
    IDENTITY: identity,
    IDENTITY_ADMIN: identityAdmin,
  } as unknown as Env;
}

export function executionContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
}

/** どのテストからも同じ origin を使う。DELETE の Origin 検証が URL と比較するため。 */
export const ORIGIN = "http://localhost";

/** 呼ばれたら必ずテストを落とす fake。「ここへ到達しないこと」を示すのに使う。 */
export function neverCalled(name: string): never {
  throw new Error(`${name} should not have been called`);
}
