import type { RateLimitDecision, RateLimiter } from "../../application/ports/rate-limiter.port";
import { RateLimitPolicy, type RateLimitScope } from "../../domain/services/rate-limit-policy";

/**
 * Cloudflare の Rate Limiting binding による実装（#21）。
 *
 * 状態は Cloudflare 側が持つので、Worker のインスタンスをまたいで共有される
 * （#21 の受け入れ条件）。メモリに置く実装は複数インスタンスで素通りになる。
 *
 * **`limit` / `period` はここでは決められない。** `wrangler.jsonc` の
 * `ratelimits` に書いた値が使われ、コードからは読めない。`Retry-After` に
 * 載せる秒数だけは `RateLimitPolicy` 側から取るので、両者がずれると
 * 利用者に見える形で間違った秒数を返す。照合は `test/rate-limit-config.test.ts`。
 */
export class CloudflareRateLimiter implements RateLimiter {
  constructor(private readonly bindings: Partial<Record<RateLimitScope, RateLimit>>) {}

  async consume(scope: RateLimitScope, key: string): Promise<RateLimitDecision> {
    const binding = this.bindings[scope];
    if (binding === undefined) {
      // 黙って通さない。binding が無いまま動くと、制限が入っているつもりで
      // 無防備になる（#88 と同じ「宣言はあるが発動しない」形）。
      throw new Error(`rate limit binding is missing: ${RateLimitPolicy[scope].binding}`);
    }

    const { success } = await binding.limit({ key });
    return success
      ? { allowed: true }
      : { allowed: false, retryAfterSeconds: RateLimitPolicy[scope].periodSeconds };
  }
}

/**
 * binding が 1 つも無い環境向け。
 *
 * **起動時ではなく消費時に失敗する**のは `UnconfiguredEmailSender` と同じ理由。
 * コンテナ組み立てで throw すると `/health` や Discovery まで 500 になり、
 * 「どこが壊れているか」が分からなくなる。
 */
export class UnconfiguredRateLimiter implements RateLimiter {
  constructor(private readonly reason: string) {}

  async consume(_scope: RateLimitScope, _key: string): Promise<RateLimitDecision> {
    throw new Error(`rate limiting is not configured: ${this.reason}`);
  }
}
