import {
  buildCsrfCookie,
  csrfCookieName as sharedCsrfCookieName,
  generateCsrfToken,
  isValidCsrf as isValidCsrfCheck,
} from "@u18/web-ui";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { isAllowedOrigin } from "../origin";
import type { AppBindings } from "../types";
import type { AuditEventName } from "../../../application/ports/audit-log.port";

/**
 * form POST 用の CSRF 対策（仕様書 9 CSRF）。
 *
 * **仕組みは `@u18/web-ui` の `csrf.ts` にある。** 方式（署名なしの
 * double-submit cookie）も、Origin 検証だけで済ませない理由も、拒否の
 * ログに何を出して何を出さないかも、すべてあちらに書いてある。
 *
 * ここに残っているのは `Context` から Cookie とヘッダを取り出す部分だけ
 * である。**dashboard-worker にも同じ adapter がある** —— 同じオリジンで
 * 配信される以上、仕組みが 2 つあるとどちらが正しいかを誰も言えなくなる。
 */

export { CSRF_FIELD_NAME } from "@u18/web-ui";

export function csrfCookieName(env: Env): string {
  return sharedCsrfCookieName(env.ENVIRONMENT);
}

/**
 * 画面を描くときに CSRF トークンを用意する。
 *
 * **既にある Cookie を使い回す。** 描画のたびに作り直すと、タブを 2 つ開いた
 * 利用者の古いほうが必ず 403 になる。ログイン画面でそれが起きると、原因が
 * 分からないまま詰む利用者が出る。
 */
export function ensureCsrfToken(c: Context<AppBindings>): string {
  const existing = getCookie(c, csrfCookieName(c.env));
  if (existing !== undefined && existing.length > 0) return existing;

  const token = generateCsrfToken();
  c.header("Set-Cookie", buildCsrfCookie(c.env.ENVIRONMENT, token), { append: true });
  return token;
}

/**
 * トークンを作り直す。
 *
 * ログイン・ログアウトのように**権限が変わる**瞬間に呼ぶ。ログイン前に
 * 攻撃者が仕込んだ値をログイン後も使い回させないため（セッション固定対策と
 * 同じ考え方）。
 */
export function rotateCsrfToken(c: Context<AppBindings>): void {
  const token = generateCsrfToken();
  c.header("Set-Cookie", buildCsrfCookie(c.env.ENVIRONMENT, token), { append: true });
}

/**
 * form POST を受け取ってよいかを判定する。
 *
 * Origin とトークンの**両方**を要求する。片方でも欠けたら拒否する。
 */
export function isValidCsrf(c: Context<AppBindings>, submitted: string | undefined): boolean {
  return isValidCsrfCheck({
    originAllowed: isAllowedOrigin(c),
    expected: getCookie(c, csrfCookieName(c.env)),
    submitted,
    // 出力先は違うが名前空間は監査イベントと同じなので、登録簿で縛る
    // （rate_limit.exceeded と同じ理由。audit-log.port.ts）。
    event: "csrf.rejected" satisfies AuditEventName,
    path: new URL(c.req.url).pathname,
    origin: c.req.header("Origin") ?? null,
    secFetchSite: c.req.header("Sec-Fetch-Site") ?? null,
  });
}
