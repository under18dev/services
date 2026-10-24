import type { Context } from "hono";
import type { AppBindings } from "./types";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * エラー応答の共通形。
 *
 * メッセージには内部状態を入れない。「そのユーザーは存在するが停止中」のような
 * 区別が外から見えると、アカウント列挙の材料になる（仕様書 9）。
 */
export function problem(
  c: Context<AppBindings>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
): Response {
  return c.json({ error: code, message }, status);
}

/** Application の UseCaseError を HTTP ステータスへ翻訳する。 */
const STATUS_BY_CODE: Record<string, ContentfulStatusCode> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  too_many_attempts: 429,
  rate_limited: 429,
};

export function statusForUseCaseError(code: string): ContentfulStatusCode {
  return STATUS_BY_CODE[code] ?? 400;
}
