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
  // 409: username の一意性のように「入力は正しいが今は通せない」衝突。
  conflict: 409,
  // 403: 認証は済んでいるが、この操作には直近の本人確認が要る（仕様書 8.1）。
  // 401 にしないのは、セッション自体は有効でログインし直す以外に
  // やり直す手段が無いため。401 だと「Cookie が切れた」と区別できない。
  reauthentication_required: 403,
  too_many_attempts: 429,
  invalid_code: 400,
  rate_limited: 429,
};

export function statusForUseCaseError(code: string): ContentfulStatusCode {
  return STATUS_BY_CODE[code] ?? 400;
}
