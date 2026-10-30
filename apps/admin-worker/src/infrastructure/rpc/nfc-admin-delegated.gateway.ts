import type { NfcAdminDelegatedRpcContract } from "@u18/contracts";

/**
 * Service Binding のスタブを契約インターフェースとして見る（#382 / #390 決定 16 ③）。
 *
 * `wrangler types` は別 Worker の Entrypoint を知らないため、binding は
 * `Service`（`Fetcher` 相当）としか型付けできない。実際の形の保証は
 * 呼ばれる側にあり、nfc-worker の `NfcAdminDelegatedRPC` が
 * `implements NfcAdminDelegatedRpcContract` でコンパイル時に検査されて
 * いる。この `as` を 1 箇所に閉じ込める（nfc-worker の
 * `identity.gateway.ts` の `asIdentityRpc` と同じ方針）。
 */
export function asNfcAdminDelegatedRpc(binding: Fetcher): NfcAdminDelegatedRpcContract {
  return binding as unknown as NfcAdminDelegatedRpcContract;
}
