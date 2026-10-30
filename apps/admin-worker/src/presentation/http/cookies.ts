/**
 * この Worker が使う 2 本の Cookie。
 *
 * **`__Host-` 接頭辞を使う**（決定 16 の裏返し——分けたホストが自分の
 * Cookie を持つことで、`__Host-` の保護をそのまま維持できる）。development
 * は http://localhost で Secure を付けられないため接頭辞を外す
 * （`packages/contracts/src/session-cookie.ts` と同じ判断）。
 */

const SESSION_COOKIE_NAME = "__Host-u18_admin_session";
const DEV_SESSION_COOKIE_NAME = "u18_admin_session";

const LOGIN_STATE_COOKIE_NAME = "__Host-u18_admin_login_state";
const DEV_LOGIN_STATE_COOKIE_NAME = "u18_admin_login_state";

export function sessionCookieName(environment: string): string {
  return environment === "development" ? DEV_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
}

export function loginStateCookieName(environment: string): string {
  return environment === "development" ? DEV_LOGIN_STATE_COOKIE_NAME : LOGIN_STATE_COOKIE_NAME;
}

function attrs(environment: string, maxAgeSeconds: number): string {
  const secure = environment === "development" ? "" : "; Secure";
  return `Path=/; Max-Age=${maxAgeSeconds}; HttpOnly${secure}; SameSite=Lax`;
}

/** セッション確立時の `Set-Cookie`。 */
export function buildSessionCookie(
  environment: string,
  token: string,
  maxAgeSeconds: number,
): string {
  return `${sessionCookieName(environment)}=${token}; ${attrs(environment, maxAgeSeconds)}`;
}

/** ログアウト・失効時にセッションを落とす `Set-Cookie`。 */
export function clearSessionCookie(environment: string): string {
  return `${sessionCookieName(environment)}=; ${attrs(environment, 0)}`;
}

/**
 * ログイン開始時の `Set-Cookie`。
 *
 * **寿命は 10 分。** 認可画面を開いたまま離席して戻ってきたときに
 * 通したいが、長くする理由は無い——この Cookie が生きている間だけ
 * `/callback` が通るので、短いほうが安全側。
 */
const LOGIN_STATE_TTL_SECONDS = 10 * 60;

export function buildLoginStateCookie(environment: string, value: string): string {
  return `${loginStateCookieName(environment)}=${value}; ${attrs(environment, LOGIN_STATE_TTL_SECONDS)}`;
}

export function clearLoginStateCookie(environment: string): string {
  return `${loginStateCookieName(environment)}=; ${attrs(environment, 0)}`;
}
