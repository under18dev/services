import type { IdentityRpcContract } from "@u18/contracts";

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
): Env {
  return {
    ENVIRONMENT: environment,
    AUTH_ISSUER: "http://localhost:8787",
    IDENTITY: identity,
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
