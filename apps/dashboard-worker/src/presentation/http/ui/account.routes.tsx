import { sessionCookieName } from "@u18/contracts";
import { pageSecurityHeaders, UI_STYLESHEET } from "@u18/web-ui";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { IdentityOutcome } from "../../../application/ports";
import type { AppBindings } from "../types";
import { AccountPage } from "./account-page";
import { GRANTS_ROUTE, OVERVIEW_ROUTE, SESSIONS_ROUTE, STYLESHEET_ROUTE } from "./asset-paths";
import { GrantsPage } from "./grants-page";
import { SignInRequiredPage, UnavailablePage } from "./message-page";
import { SessionsPage } from "./sessions-page";

/**
 * アカウント管理画面（#9 / 仕様書 8.1）。
 *
 * ## JSON の経路と同じ RPC を、同じ Worker から読む
 *
 * `/account/api/*` と**同じ `IdentityGateway`** を使う。ページ用に別の
 * 取得経路を作ると、片方だけ認可が緩む余地ができる。
 *
 * ## 失敗の出し方が JSON 経路と違う
 *
 * JSON は `{ error: code }` を返すが、ページは**人が読む文**を返す。
 * ただし**内部の事情は書かない** —— `identity_unavailable` の `detail` は
 * 画面に出さない。
 *
 * ステータスコードは JSON 経路と揃える（未ログイン 401 / 届かない 503）。
 * 200 で「エラーです」と書いた HTML を返すと、外形監視からは正常に見える。
 */

export const accountUiRoutes = new Hono<AppBindings>()
  /**
   * アカウント概要。プロフィールと Passkey を 1 ページに出す。
   *
   * 2 本の RPC を**並行**で呼ぶ。直列にすると往復が 2 回分になり、
   * どちらも同じセッションで同じ auth-worker を叩くので待つ意味が無い。
   */
  .get(OVERVIEW_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return c.html(<SignInRequiredPage />, 401);

    const identity = c.get("identity");
    const [profile, passkeys] = await Promise.all([
      identity.getProfile(token),
      identity.listPasskeys(token),
    ]);

    if (!profile.ok) return renderFailure(c, profile);
    // セッションが無効なら、Passkey の結果がどうであれログインからやり直し。
    if (profile.value === null) return c.html(<SignInRequiredPage />, 401);
    if (!passkeys.ok) return renderFailure(c, passkeys);

    return c.html(<AccountPage profile={profile.value} passkeys={passkeys.value} />);
  })

  .get(SESSIONS_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return c.html(<SignInRequiredPage />, 401);

    const sessions = await c.get("identity").listSessions(token);
    if (!sessions.ok) return renderFailure(c, sessions);

    return c.html(<SessionsPage sessions={sessions.value} />);
  })

  .get(GRANTS_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return c.html(<SignInRequiredPage />, 401);

    const grants = await c.get("identity").listGrants(token);
    if (!grants.ok) return renderFailure(c, grants);

    return c.html(<GrantsPage grants={grants.value} />);
  })

  /**
   * 共有スタイルシート。
   *
   * **この Worker で唯一、`no-store` を上書きする経路である。**
   * 返すのは全利用者に同じ CSS で、個人情報を 1 文字も含まない。
   * 他の経路（#125 / RR-10）と違い、キャッシュさせて問題が無い。
   *
   * `max-age` が短いのは URL に内容ハッシュを含めていないため。
   * デプロイ後に古い CSS が残る窓を 5 分に抑える（auth-worker と同じ値）。
   *
   * **ここを真似して他の経路でキャッシュを許さないこと。** 増やすなら、
   * `test/cache-control.test.ts` の「例外はこれ 1 つ」を更新したうえで、
   * なぜ個人情報が含まれないのかを書くこと。
   */
  .get(STYLESHEET_ROUTE, (c) =>
    c.body(UI_STYLESHEET, 200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    }),
  );

/**
 * 取得できなかったときの画面。
 *
 * 失敗の種類で分けるのは「ログインし直せば直る」かどうかだけ。それ以外
 * （`forbidden` / `not_found` / `conflict` など）は、この読み取り専用の
 * 画面では利用者にできることが無いので「一時的に表示できません」に畳む。
 */
function renderFailure(
  c: Context<AppBindings>,
  outcome: Extract<IdentityOutcome<unknown>, { ok: false }>,
  // `c.html()` は Promise を返すことがある（JSX の子が非同期になりうるため）。
  // ここで `Response` に狭めると、将来子を非同期にした瞬間に型で落ちる。
): Response | Promise<Response> {
  if (outcome.failure.kind === "unauthenticated") {
    return c.html(<SignInRequiredPage />, 401);
  }
  return c.html(<UnavailablePage />, 503);
}
