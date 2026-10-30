import { Hono } from "hono";
import { rotateCsrfToken } from "../../../src/presentation/http/csrf";

/**
 * **走査が「見つける」側の見本。** `rotateCsrfToken` を GET のハンドラで
 * 呼んでいる。
 *
 * `rotateCsrfToken` 自体は何も検証しない。GET に置くと、第三者のページから
 * `<img src>` ひとつで被害者の CSRF Cookie を回せる —— 開いている form が
 * すべて無効になる（共有側 `buildCsrfCookie` の「誤用の形」2 を参照）。
 */
export const badRoutes = new Hono<{ Variables: { identity: string } }>();

badRoutes.get("/rotate-on-read", (c) => {
  rotateCsrfToken(c as never);
  return c.text("ok");
});

badRoutes.post("/rotate-after-write", (c) => {
  // **こちらは正しい形。** 走査が動詞を見分けていることの対照であると同時に、
  // **`c.get()` を経路の登録と取り違えないこと**も見ている —— 取り違えると
  // この行が「直前の経路は GET」に見え、下の正しい rotate が違反として出る。
  const identity = c.get("identity");
  rotateCsrfToken(c as never);
  return c.text(identity);
});
