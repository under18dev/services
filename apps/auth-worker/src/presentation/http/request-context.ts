import type { Context } from "hono";
import type { RequestContext } from "../../composition/container";
import { clientIp } from "./rate-limit";
import type { AppBindings } from "./types";

/**
 * リクエストの発信元を 1 箇所で組み立てる（#122）。
 *
 * IP は `clientIp()` を使い回す。`CF-Connecting-IP` という名前と
 * 「`X-Forwarded-For` は見ない」という判断を 2 箇所に書くと、片方だけ直す
 * 事故が起きる —— レート制限の鍵と監査ログの `ip_hash` が別の値を指す
 * 状態は、どちらを見ても調査が成立しなくなるので特に悪い。
 */
export function requestContext(c: Context<AppBindings>): RequestContext {
  return {
    ip: clientIp(c),
    userAgent: c.req.header("User-Agent") ?? null,
    // 応答後へ副作用を逃がすのに使う（#126）。`executionCtx` はテストの
    // 一部の呼び出し方だと存在せず、触ると投げるので握る。無ければ
    // 副作用は応答前に待つ側へ倒れる（消えるよりよい）。
    waitUntil: waitUntilOf(c),
  };
}

function waitUntilOf(c: Context<AppBindings>): ((task: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (task) => ctx.waitUntil(task);
  } catch {
    return undefined;
  }
}
