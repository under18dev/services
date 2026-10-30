import type { Context } from "hono";

/** **走査が「見つける」側の見本。** 本文を読むのに判定を通していない経路。 */
export async function readWithoutGuard(c: Context): Promise<string> {
  const body = await c.req.parseBody();
  return String(body["example"] ?? "");
}
