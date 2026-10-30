import type { Context } from "hono";
import { isValidCsrf } from "../../../src/presentation/http/csrf";

/**
 * **走査が「見つける」側の見本。** `isValidCsrf` を import しているが
 * **呼んでいない**ハンドラ。
 *
 * 描画側の「hidden input の置き忘れ」と同じ、いちばんありそうな間違いで
 * ある。判定を「ファイルにこの名前が出てくるか」にすると**守られていると
 * 誤判定する。**
 */
export const guardReference = isValidCsrf;

export async function readWithoutCallingGuard(c: Context): Promise<string> {
  const body = await c.req.parseBody();
  return String(body["example"] ?? "");
}
