import { buildClearedSessionCookie as buildCleared, sessionCookieName } from "@u18/contracts";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppBindings } from "./types";

/**
 * セッション Cookie の読み書き（仕様書 5.3 / 9）。
 *
 * 名前そのものは packages/contracts で dashboard-worker と共有する。
 * `__Host-` 接頭辞がドメイン構成の選択肢を縛る点はそちらに書いてある。
 */
export function cookieNameFor(env: Env): string {
  return sessionCookieName(env.ENVIRONMENT);
}

export function readSessionCookie(c: Context<AppBindings>): string | null {
  const name = cookieNameFor(c.env);
  return getCookie(c, name) ?? null;
}

export function buildSessionCookie(env: Env, token: string, expiresAt: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const secure = env.ENVIRONMENT === "development" ? "" : "; Secure";
  // SameSite=Lax: OIDC の authorize はトップレベル遷移なので Lax で届く。
  // None にするとクロスサイトの POST にも付いてしまう。
  return `${cookieNameFor(env)}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly${secure}; SameSite=Lax`;
}

export function buildClearedSessionCookie(env: Env): string {
  // 生成は packages/contracts に 1 つだけ置く。dashboard-worker も同じ
  // Cookie を落とすので、属性がずれると片方が消せなくなる。
  return buildCleared(env.ENVIRONMENT);
}
