import { sessionCookieName } from "@u18/contracts";
import { IMMUTABLE_ASSET_CACHE_CONTROL, pageSecurityHeaders, UI_STYLESHEET } from "@u18/web-ui";
import { ACCOUNT_ISLAND_JS } from "./generated/account-island.bundle";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { IdentityOutcome } from "../../../application/ports";
import type { AppBindings } from "../types";
import { HomePage } from "./home-page";
import {
  APPS_ROUTE,
  GRANTS_ROUTE,
  ISLAND_ROUTE,
  OVERVIEW_ROUTE,
  PASSKEYS_ROUTE,
  PROFILE_ROUTE,
  SESSIONS_ROUTE,
  STYLESHEET_ROUTE,
} from "./asset-paths";
import { APP_CATALOG, buildAppCatalog } from "./app-catalog";
import { AppsPage } from "./apps-page";
import { GrantsPage } from "./grants-page";
import { PasskeysPage } from "./passkeys-page";
import { ProfilePage } from "./profile-page";
import { SignInRequiredPage, UnavailablePage } from "./message-page";
import { SessionsPage } from "./sessions-page";
import { returnToForCurrentRequest } from "@u18/contracts";

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

/**
 * 静的アセットの `Cache-Control`。**この Worker で唯一 `no-store` を
 * 上書きする値である。**
 *
 * 返すのは全利用者に同じ CSS / JS で、個人情報を 1 文字も含まない。
 * 他の経路（#125 / RR-10）と違い、キャッシュさせて問題が無い。
 *
 * **URL に内容ハッシュが入っている**（#211、`asset-paths.ts`）ので
 * `immutable` で永久に持たせてよい。中身が変われば URL が変わるため、
 * 古いものを掴んだブラウザと新しいサーバーが重なる窓が無い。
 *
 * **ここを真似して他の経路でキャッシュを許さないこと。** 増やすなら
 * `test/cache-control.test.ts` の「例外はこれだけ」を更新したうえで、
 * なぜ個人情報が含まれないのかを書くこと。
 */
const ASSET_CACHE_CONTROL = IMMUTABLE_ASSET_CACHE_CONTROL;

export const accountUiRoutes = new Hono<AppBindings>()
  /**
   * ダッシュボードのホーム（#308）。
   *
   * **4 本の RPC を並行で呼ぶ。** 直列にすると往復が 4 回分になり、
   * どれも同じセッションで同じ auth-worker を叩くので待つ意味が無い。
   *
   * ここは件数しか出さないが、**件数を出すには一覧を引くしかない** ——
   * `IdentityRPC` に「数だけ返す」口を足すと、同じ問いに入口が 2 つできる
   * （件数と一覧がずれる形は、このリポジトリが繰り返し踏んでいる）。
   * 行数が小さいうちは一覧を引いて数える。
   */
  .get(OVERVIEW_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const identity = c.get("identity");
    const [profile, passkeys, sessions, grants] = await Promise.all([
      identity.getProfile(token),
      identity.listPasskeys(token),
      identity.listSessions(token),
      identity.listGrants(token),
    ]);

    if (!profile.ok) return renderFailure(c, profile);
    // セッションが無効なら、他の結果がどうであれログインからやり直し。
    if (profile.value === null) return signInRequired(c);
    if (!passkeys.ok) return renderFailure(c, passkeys);
    if (!sessions.ok) return renderFailure(c, sessions);
    if (!grants.ok) return renderFailure(c, grants);

    return c.html(
      <HomePage
        displayName={profile.value.displayName}
        passkeyCount={passkeys.value.length}
        sessionCount={sessions.value.length}
        grantCount={grants.value.length}
      />,
    );
  })

  .get(PROFILE_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const profile = await c.get("identity").getProfile(token);
    if (!profile.ok) return renderFailure(c, profile);
    if (profile.value === null) return signInRequired(c);

    return c.html(<ProfilePage profile={profile.value} />);
  })

  .get(PASSKEYS_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const passkeys = await c.get("identity").listPasskeys(token);
    if (!passkeys.ok) return renderFailure(c, passkeys);

    return c.html(<PasskeysPage passkeys={passkeys.value} />);
  })

  .get(SESSIONS_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const sessions = await c.get("identity").listSessions(token);
    if (!sessions.ok) return renderFailure(c, sessions);

    return c.html(<SessionsPage sessions={sessions.value} />);
  })

  .get(GRANTS_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const grants = await c.get("identity").listGrants(token);
    if (!grants.ok) return renderFailure(c, grants);

    return c.html(<GrantsPage grants={grants.value} />);
  })

  /**
   * u18 Identity で使えるアプリのカタログ（#308）。
   *
   * **カタログ自体はコードにある**（`app-catalog.ts`。D1 から引かない理由は
   * あちらの冒頭）。それでも `listGrants` を呼ぶのは、**「連携済み」バッジを
   * 出すため**である。カタログと実態を結びつけているのがこの 1 本の RPC で、
   * これが無いと「どこへ行けるか」は出せても「もう繋いだのか」は出せない。
   *
   * **ログインを要求する。** 中身は全利用者に同じだが、バッジが自分の
   * `oauth_grants` を映すので、Cookie が無い状態で出すと「誰のバッジでも
   * ない一覧」になる。他の画面と同じ 401 に揃えるほうが、入口の扱いが
   * 1 つで済む。
   *
   * ## `listGrants` が落ちても 503 にしない
   *
   * **この Worker で唯一、RPC が失敗しても出せる中身がある画面である。**
   * 他の 5 枚は一覧そのものが RPC の戻り値なので、取れなければ出すものが
   * 無い。こちらは本体がコードの中にあり、RPC はバッジという付加情報を
   * 足すためだけに呼んでいる。**付加情報の失敗で本体を道連れにしない。**
   *
   * 代わりに `grantsKnown: false` を画面へ渡し、「いま確認できない」と
   * 言わせる（`apps-page.tsx`）。**黙ってバッジを消さない** —— 連携して
   * いるのにしていないように見える。
   *
   * **`unauthenticated` だけは 401 へ回す。** セッションが死んでいるなら、
   * サイドバーの行き先が全部 401 になる画面を出しても押すたびに戻される
   * だけで、ログインし直すほうが早い。
   */
  .get(APPS_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const grants = await c.get("identity").listGrants(token);
    if (!grants.ok && grants.failure.kind === "unauthenticated") return renderFailure(c, grants);

    // `null` は「取れなかった」。**「連携が 0 件」と同じ値にしないこと。**
    return c.html(
      <AppsPage view={buildAppCatalog(APP_CATALOG, grants.ok ? grants.value : null)} />,
    );
  })

  /** 共有スタイルシート（`@u18/web-ui` の `UI_STYLESHEET`）。 */
  .get(STYLESHEET_ROUTE, (c) =>
    c.body(UI_STYLESHEET, 200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": ASSET_CACHE_CONTROL,
    }),
  )

  /**
   * 取り消し操作のアイランド。スタイルシートと同じく個人情報を含まない。
   *
   * **auth-worker の `/ui/login-island.js` とは別物**なので借りられない
   * （あちらは WebAuthn 専用）。
   */
  .get(ISLAND_ROUTE, (c) =>
    c.body(ACCOUNT_ISLAND_JS, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": ASSET_CACHE_CONTROL,
    }),
  );

/**
 * 取得できなかったときの画面。
 *
 * 失敗の種類で分けるのは「ログインし直せば直る」かどうかだけ。それ以外
 * （`forbidden` / `not_found` / `conflict` など）は、この読み取り専用の
 * 画面では利用者にできることが無いので「一時的に表示できません」に畳む。
 */
/**
 * ログインが必要なときの応答。**1 箇所に置く。**
 *
 * 画面ごとに `<SignInRequiredPage />` を書くと、**次に足した画面だけ
 * 戻り先を載せ忘れる**。載せ忘れても誰も落ちず、利用者が自分で辿り直す
 * ことになるだけなので気づかない。
 */
function signInRequired(c: Context<AppBindings>): Response | Promise<Response> {
  // いま見ようとしていた画面へ戻れるようにする。値の妥当性は
  // auth-worker の `sanitizeReturnTo` が判断する（関門は 1 つ）。
  return c.html(<SignInRequiredPage returnTo={returnToForCurrentRequest(c.req.url)} />, 401);
}

function renderFailure(
  c: Context<AppBindings>,
  outcome: Extract<IdentityOutcome<unknown>, { ok: false }>,
  // `c.html()` は Promise を返すことがある（JSX の子が非同期になりうるため）。
  // ここで `Response` に狭めると、将来子を非同期にした瞬間に型で落ちる。
): Response | Promise<Response> {
  if (outcome.failure.kind === "unauthenticated") {
    // いま見ようとしていた画面へ戻れるようにする。値の妥当性は
    // auth-worker の `sanitizeReturnTo` が判断する（関門は 1 つ）。
    return c.html(<SignInRequiredPage returnTo={returnToForCurrentRequest(c.req.url)} />, 401);
  }
  return c.html(<UnavailablePage />, 503);
}
