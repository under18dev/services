import { createAdminDatabase } from "@u18/admin-db";
import type {
  IdentityAdminDelegatedRpcContract,
  NfcAdminDelegatedRpcContract,
} from "@u18/contracts";
import { asFetcher } from "../infrastructure/http/auth-origin.gateway";
import { asIdentityAdminDelegatedRpc } from "../infrastructure/rpc/identity-admin-delegated.gateway";
import { asNfcAdminDelegatedRpc } from "../infrastructure/rpc/nfc-admin-delegated.gateway";
import type { ApprovalRepository } from "../application/ports/approval.repository";
import { DrizzleApprovalRepository } from "../infrastructure/persistence/drizzle-approval.repository";
import { DiscoveryCache } from "../oidc/discovery-cache";

/**
 * Composition Root。`Env` を読んでよいのはここだけ。
 *
 * `fetcher` と `clock` を上書きできるのは、discovery / token 交換を
 * テストから本物の HTTP 無しで確かめるため（`oidc/discovery.ts` の
 * JSDoc を参照）。`approvals` を上書きできるのは、D1 を立てずに
 * ルーティングの分岐（承認済み／未承認）だけを確かめるテストのため。
 *
 * **既定の `fetcher` は `AUTH_ORIGIN` binding 経由である**（#439）。
 * 以前は本物の `fetch` で `https://auth.under18.dev/...` を直接叩いて
 * おり、本番で Cloudflare のループ防止（同一ゾーンへの Worker 発
 * サブリクエストが discard prefix へ流れる）に当たって 522 で落ちた。
 * `entrypoint` を指定しない Service Binding は、ゾーンのルーティングを
 * 経由せずに auth-worker の公開 HTTP（`fetch` ハンドラそのもの）へ
 * 繋がるので、この種の失敗が起こらない。discovery・JWKS・token 交換の
 * どれもここを通るので、1 箇所直すだけで 3 つとも直る
 * （`infrastructure/http/auth-origin.gateway.ts` を参照）。
 */

export type Clock = { readonly now: () => Date };

export const systemClock: Clock = { now: () => new Date() };

export type ContainerOverrides = {
  readonly fetcher?: typeof fetch;
  readonly clock?: Clock;
  readonly approvals?: ApprovalRepository;
  /** nfc-worker への delegated RPC。テストでは fake を差して Service Binding 無しで確かめる。 */
  readonly nfcCards?: NfcAdminDelegatedRpcContract;
  /** auth-worker への delegated RPC（#390 決定 16 ③）。同上。 */
  readonly identityAdmin?: IdentityAdminDelegatedRpcContract;
};

/**
 * **モジュールスコープに 1 つだけ持つ。**
 *
 * `createContainer` はリクエストごとに呼ばれる（`app.ts` のミドルウェア）
 * ので、`DiscoveryCache` をそこで作ると毎回新しいインスタンスになり、
 * キャッシュが一度も当たらない。Issuer ごとに 1 つ、アイソレートが
 * 生きている間だけ使い回す。
 *
 * テストで `fetcher` を上書きしたときにこのキャッシュへ古い応答が
 * 残らないよう、`overrides.fetcher` が渡されたときはキャッシュを
 * 共有しない（モジュールスコープの Map を issuer+fetcher identity で
 * 分けるのではなく、overrides 時は常に新規作成する）。
 */
const discoveryCaches = new Map<string, DiscoveryCache>();

export function createContainer(env: Env, overrides: ContainerOverrides = {}) {
  const fetcher = overrides.fetcher ?? asFetcher(env.AUTH_ORIGIN);
  const clock = overrides.clock ?? systemClock;
  const issuer = env.AUTH_ISSUER;

  let discovery: DiscoveryCache;
  if (overrides.fetcher !== undefined || overrides.clock !== undefined) {
    discovery = new DiscoveryCache(fetcher, issuer, clock);
  } else {
    const existing = discoveryCaches.get(issuer);
    if (existing !== undefined) {
      discovery = existing;
    } else {
      discovery = new DiscoveryCache(fetcher, issuer, clock);
      discoveryCaches.set(issuer, discovery);
    }
  }

  const approvals =
    overrides.approvals ?? new DrizzleApprovalRepository(createAdminDatabase(env.ADMIN_DB));
  const nfcCards = overrides.nfcCards ?? asNfcAdminDelegatedRpc(env.NFC_ADMIN_DELEGATED);
  const identityAdmin =
    overrides.identityAdmin ?? asIdentityAdminDelegatedRpc(env.IDENTITY_ADMIN_DELEGATED);

  return { env, fetcher, clock, discovery, approvals, nfcCards, identityAdmin };
}

export type Container = ReturnType<typeof createContainer>;
