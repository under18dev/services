import {
  buildCsrfCookie,
  csrfCookieName as sharedCsrfCookieName,
  generateCsrfToken,
  isTrustedOrigin,
  isValidCsrf as isValidCsrfCheck,
} from "@u18/web-ui";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppBindings } from "./types";

/**
 * form POST 用の CSRF 対策（仕様書 9 CSRF）。
 *
 * **仕組みは `@u18/web-ui` の `csrf.ts` にあり、auth-worker / dashboard-worker /
 * nfc-worker と同じものである。** ここは `Context` から Cookie とヘッダを
 * 取り出す adapter だけ（nfc-worker の同名ファイルと同じ方針）。
 *
 * ## この Worker で最初の form POST（#382 / #390 決定 16 ③）
 *
 * NFC 管理画面（発行・無効化・遷移先の書き換え）が最初に form を持つ。
 * **走査（`collectFormCsrfSites`）はまだ移植していない。** いま form は
 * この 1 画面だけで、`test/nfc.routes.test.ts` が直接見ている。
 *
 * **2 本目の form を足す人へ: 先にあの走査を移植すること**（nfc-worker /
 * dashboard-worker の同名ファイルが #363 として残している注意と同じ）。
 */

export { CSRF_FIELD_NAME } from "@u18/web-ui";

function cookieName(c: Context<AppBindings>): string {
  return sharedCsrfCookieName(c.env.ENVIRONMENT);
}

/**
 * 画面を描くときに CSRF トークンを用意する。
 *
 * **既にある Cookie を使い回す。** 描画のたびに作り直すと、タブを 2 つ開いた
 * 利用者の古いほうが必ず 403 になる。
 */
export function ensureCsrfToken(c: Context<AppBindings>): string {
  const existing = getCookie(c, cookieName(c));
  if (existing !== undefined && existing.length > 0) return existing;

  const token = generateCsrfToken();
  c.header("Set-Cookie", buildCsrfCookie(c.env.ENVIRONMENT, token), { append: true });
  return token;
}

/**
 * form POST を受け取ってよいかを判定する。
 *
 * Origin とトークンの**両方**を要求する。片方でも欠けたら拒否する。
 *
 * 落ちたときの画面は `ui/message-page.tsx` の `csrfRejected()` を使う
 * こと（#443）。以前はここに `"forbidden"` を英語のまま返していたが、
 * 運用者の指示（人がブラウザで到達しうる経路は全部 Kiwa UI で作り込む）
 * を受けて置き換えた。
 */
export function isValidCsrf(c: Context<AppBindings>, submitted: string | undefined): boolean {
  return isValidCsrfCheck({
    originAllowed: isTrustedOrigin(
      c.req.header("Origin"),
      c.req.header("Sec-Fetch-Site"),
      new URL(c.req.url).origin,
    ),
    expected: getCookie(c, cookieName(c)),
    submitted,
    // **拒否したリクエストを D1 には書かない。** 攻撃者が書き込みを
    // 誘発できる経路を作らない（nfc-worker と同じ理由）。
    event: "csrf.rejected",
    path: new URL(c.req.url).pathname,
    origin: c.req.header("Origin") ?? null,
    secFetchSite: c.req.header("Sec-Fetch-Site") ?? null,
  });
}
