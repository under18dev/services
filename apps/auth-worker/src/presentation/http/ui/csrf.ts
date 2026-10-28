import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { isAllowedOrigin } from "../origin";
import type { AppBindings } from "../types";
import type { AuditEventName } from "../../../application/ports/audit-log.port";

/**
 * form POST 用の CSRF 対策（仕様書 9 CSRF）。
 *
 * ## なぜ Origin 検証だけで済ませないのか
 *
 * 既存の JSON API は `isAllowedOrigin()` だけで守っている。ブラウザは
 * `fetch` の POST に必ず Origin を付けるので、それで十分だった。
 * ところが **HTML の form 送信は Origin の付き方がブラウザ・設定に依存する**。
 * `isAllowedOrigin()` は fail-closed（Origin が無ければ拒否）なので、
 * Origin を送らない経路があると「正規の利用者がログインできない」側に倒れる。
 *
 * かといって form のときだけ Origin 検証を緩めると、CSRF 対策が SameSite
 * 頼みになる。そこで form には **Origin 検証 + トークン**の二重にし、
 * Origin 側は「そもそも落ちない」ことを前提にしない。
 *
 * ## 方式: 署名なしの double-submit cookie
 *
 * HttpOnly な Cookie に 256bit のランダム値を入れ、同じ値を hidden input に
 * 埋めて、POST 時に定時間比較する。攻撃者はクロスサイトからこの Cookie を
 * 読めず（HttpOnly かつ SameSite=Lax）、値を当てることもできない。
 * HMAC 方式にしないのは、鍵（Secret）を 1 つ増やさずに同じ強度が得られるため。
 *
 * セッション Cookie と同じく、本番は `__Host-` 接頭辞を使う。
 * サブドメインから上書きされると double-submit が成立しなくなるため、
 * ここは接頭辞の保護が効いていることが前提条件になっている。
 */

const CSRF_COOKIE_NAME = "__Host-u18_csrf";
/** development は http://localhost で Secure を付けられないので接頭辞なし。 */
const DEV_CSRF_COOKIE_NAME = "u18_csrf";

/** form に埋める hidden input の名前。 */
export const CSRF_FIELD_NAME = "csrf_token";

/** Cookie の寿命。ログイン画面を開いてから入力を終えるまでの時間だけあればよい。 */
const CSRF_COOKIE_MAX_AGE_SECONDS = 60 * 60;

export function csrfCookieName(env: Env): string {
  return env.ENVIRONMENT === "development" ? DEV_CSRF_COOKIE_NAME : CSRF_COOKIE_NAME;
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

  const token = c.get("container").services.tokens.generate();
  c.header("Set-Cookie", buildCsrfCookie(c.env, token), { append: true });
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
  const token = c.get("container").services.tokens.generate();
  c.header("Set-Cookie", buildCsrfCookie(c.env, token), { append: true });
}

function buildCsrfCookie(env: Env, token: string): string {
  const secure = env.ENVIRONMENT === "development" ? "" : "; Secure";
  // HttpOnly にできるのは、トークンをサーバー側で HTML に埋めるため。
  // JS から読む必要がない以上、読めなくしておく。
  return `${csrfCookieName(env)}=${token}; Path=/; Max-Age=${CSRF_COOKIE_MAX_AGE_SECONDS}; HttpOnly${secure}; SameSite=Lax`;
}

/**
 * form POST を受け取ってよいかを判定する。
 *
 * Origin とトークンの**両方**を要求する。片方でも欠けたら拒否する。
 */
export function isValidCsrf(c: Context<AppBindings>, submitted: string | undefined): boolean {
  const expected = getCookie(c, csrfCookieName(c.env));

  /**
   * 落ちた理由を**ログにだけ**出す。
   *
   * 画面には書かない —— 「トークンが古い」「Origin が違う」を出し分けると、
   * 攻撃者に何を直せばよいか教えることになる（`rejectCsrf` の方針）。
   *
   * **ログに出ないと調べようがない。** 実際、本番で
   * 「どのメールアドレスを入れても操作を受け付けられない」という報告が出て、
   * `wrangler tail` で生のヘッダを見るまで `Origin: null` だと分からなかった。
   * 理由が 1 行出ていれば、そこで終わっていた。
   *
   * **値そのものは出さない。** トークンをログに書くと、ログを読める範囲が
   * そのまま CSRF を抜ける範囲になる。長さと有無だけで切り分けはつく。
   */
  const deny = (reason: string): false => {
    console.warn(
      JSON.stringify({
        // 出力先は違うが名前空間は監査イベントと同じなので、登録簿で縛る
        // （rate_limit.exceeded と同じ理由。audit-log.port.ts）。
        event: "csrf.rejected" satisfies AuditEventName,
        reason,
        path: new URL(c.req.url).pathname,
        origin: c.req.header("Origin") ?? null,
        secFetchSite: c.req.header("Sec-Fetch-Site") ?? null,
        hasCookie: expected !== undefined && expected.length > 0,
        submittedLength: submitted?.length ?? 0,
      }),
    );
    return false;
  };

  if (!isAllowedOrigin(c)) return deny("origin");
  if (expected === undefined || expected.length === 0) return deny("no_cookie");
  if (submitted === undefined || submitted.length === 0) return deny("no_token");
  if (!c.get("container").services.comparator.equals(expected, submitted)) {
    return deny("token_mismatch");
  }
  return true;
}
