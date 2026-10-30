import { createAdminDatabase } from "@u18/admin-db";
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
 */

export type Clock = { readonly now: () => Date };

export const systemClock: Clock = { now: () => new Date() };

export type ContainerOverrides = {
  readonly fetcher?: typeof fetch;
  readonly clock?: Clock;
  readonly approvals?: ApprovalRepository;
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
  const fetcher = overrides.fetcher ?? fetch;
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

  return { env, fetcher, clock, discovery, approvals };
}

export type Container = ReturnType<typeof createContainer>;
