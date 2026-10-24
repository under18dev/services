import type { RateLimitScope } from "../../domain/services/rate-limit-policy";

export type RateLimitDecision =
  | { readonly allowed: true }
  /**
   * `retryAfterSeconds` は**窓の長さそのもの**で、残り時間ではない。
   *
   * Cloudflare の binding は `{ success: boolean }` しか返さず、窓がいつ
   * 空くかを教えてくれない。短めに見積もって再試行を促すと、まだ閉じている
   * 窓を叩かせることになるので、必ず窓全体を返す。
   */
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * レート制限の Port（#21、仕様書 9 Abuse）。
 *
 * **1 回呼ぶと 1 回消費する。** 「今どうなっているか」を覗く手段は
 * 意図的に用意していない。覗いてから消費する 2 段に分けると、その隙間に
 * 並行リクエストが入って上限を超えられる（`EmailChallengeRepository.consume()`
 * が同じ理由で原子的になっているのと同じ）。
 */
export interface RateLimiter {
  consume(scope: RateLimitScope, key: string): Promise<RateLimitDecision>;
}
