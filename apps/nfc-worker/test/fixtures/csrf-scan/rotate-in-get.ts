import { Hono } from "hono";

/**
 * **走査が「見つける」側の見本。** `rotateCsrfToken` を GET のハンドラで
 * 呼んでいる。
 *
 * `rotateCsrfToken` 自体は何も検証しない。GET に置くと、第三者のページから
 * `<img src>` ひとつで被害者の CSRF Cookie を回せる —— 開いている form が
 * すべて無効になる（共有側 `buildCsrfCookie` の「誤用の形」2 を参照）。
 *
 * ## dashboard-worker の見本と 1 箇所だけ違う
 *
 * あちらは本物の `rotateCsrfToken` を import しているが、**この Worker の
 * `http/csrf.ts` はそれを持っていない**（あのファイルに理由がある ——
 * トークンを回す場面がまだ無い）。
 *
 * **見本のためだけに本物へ関数を足さない。** 使われないものを公開すると、
 * 次に読む人が「回してよい場面がある」と読む。ここでは同じ名前の空の関数を
 * 置いて、**走査が名前と呼び出し位置だけを見ていること**を確かめる。
 * 本物が入った日に、この見本は import へ差し替えればよい。
 */
function rotateCsrfToken(_c: unknown): void {
  // 走査は `function rotateCsrfToken(` の行を飛ばす。定義は呼び出しではない。
}

export const badRoutes = new Hono<{ Variables: { identity: string } }>();

badRoutes.get("/rotate-on-read", (c) => {
  rotateCsrfToken(c);
  return c.text("ok");
});

badRoutes.post("/rotate-after-write", (c) => {
  // **こちらは正しい形。** 走査が動詞を見分けていることの対照であると同時に、
  // **`c.get()` を経路の登録と取り違えないこと**も見ている —— 取り違えると
  // この行が「直前の経路は GET」に見え、下の正しい rotate が違反として出る。
  const identity = c.get("identity");
  rotateCsrfToken(c);
  return c.text(identity);
});
