import type { IdentityAdminDelegatedRpcContract } from "@u18/contracts";

/**
 * Service Binding のスタブを契約インターフェースとして見る（#390 決定 16 ③）。
 *
 * `nfc-admin-delegated.gateway.ts` と同じ方針。`wrangler types` は別
 * Worker の Entrypoint を知らないため、binding は `Service`（`Fetcher`
 * 相当）としか型付けできない。実際の形の保証は呼ばれる側にあり、
 * auth-worker の `IdentityAdminDelegatedRPC` が
 * `implements IdentityAdminDelegatedRpcContract` でコンパイル時に
 * 検査されている。この `as` を 1 箇所に閉じ込める。
 */
export function asIdentityAdminDelegatedRpc(binding: Fetcher): IdentityAdminDelegatedRpcContract {
  return binding as unknown as IdentityAdminDelegatedRpcContract;
}
