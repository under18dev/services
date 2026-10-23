import type { Context } from "hono";
import { getCookie } from "hono/cookie";

/**
 * セッション Cookie の読み書き（仕様書 5.3 / 9）。
 *
 * `__Host-` 接頭辞は「Secure かつ Path=/ かつ Domain 指定なし」をブラウザに
 * 強制させる。サブドメインから Cookie を上書きされる経路を塞ぐため使う。
 * Cookie のドメイン境界は未決定（仕様書 14-1）だが、既定はホスト限定にしておく。
 */
export const SESSION_COOKIE_NAME = "__Host-u18_session";

/** 開発時は http://localhost で Secure が付けられないため接頭辞なしを許す。 */
export const DEV_SESSION_COOKIE_NAME = "u18_session";

export function cookieNameFor(env: Env): string {
  return env.ENVIRONMENT === "development" ? DEV_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
}

export function readSessionCookie(c: Context<{ Bindings: Env }>): string | null {
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
  const secure = env.ENVIRONMENT === "development" ? "" : "; Secure";
  return `${cookieNameFor(env)}=; Path=/; Max-Age=0; HttpOnly${secure}; SameSite=Lax`;
}
