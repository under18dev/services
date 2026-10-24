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
  };
}
