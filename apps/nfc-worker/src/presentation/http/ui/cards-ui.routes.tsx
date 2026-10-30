import { loginUrlWithReturnTo, returnToForCurrentRequest, sessionCookieName } from "@u18/contracts";
import { IMMUTABLE_ASSET_CACHE_CONTROL, pageSecurityHeaders } from "@u18/web-ui";
import { ISLAND_PATH, KIWA_STYLESHEET_PATH } from "./asset-paths";
import { CARDS_ISLAND_JS } from "./generated/cards-island.bundle";
import { KIWA_STYLESHEET } from "./generated/kiwa-stylesheet";
import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { AppBindings } from "../types";
import { CardsPage } from "./cards-page";

/**
 * カード一覧の画面（#31 の管理 API に対する UI）。
 *
 * ## なぜ nfc-worker が HTML を返すのか
 *
 * `u18-nfc` の D1 を持つのは nfc-worker だけである（仕様書 2.2 の裏返し）。
 * dashboard-worker から見せようとすると、カードを読むためだけに
 * nfc-worker への Service Binding を増やすことになる。
 *
 * **同じオリジンに載っているので、利用者からは 1 つの画面に見える。**
 * `wrangler.jsonc` の route に `auth.under18.dev/account/nfc/*` があり、
 * `__Host-` のセッション Cookie はこのホストへ送られる（§14.1 決定 1）。
 *
 * ## 未ログインはログイン画面へ送る
 *
 * API（`cards.routes.ts`）は 401 の JSON を返すが、**画面で JSON を
 * 見せても利用者にできることが無い**。`/login` へ送る。
 */
export function registerCardsUiRoutes(app: Hono<AppBindings>, path: string): void {
  /**
   * Kiwa UI のスタイルシート（#332 / #338）。
   *
   * **auth-worker から借りるのをやめた**（#211）。理由は
   * `ui/asset-paths.ts` に書いてある。URL に内容ハッシュが入っているので
   * `immutable` で配信してよい。
   *
   * **手書きの `u18.css` はもう配信していない。** この Worker の画面が
   * 1 枚も読まなくなったので、配信ルートだけが残る形を避けた。
   *
   * この画面が返す HTML は `no-store` のままである（カードの状態は
   * 所有者固有）。ここだけが例外で、**中身は全利用者に同じ CSS で、
   * 個人情報を 1 文字も含まない。**
   */
  app.get(KIWA_STYLESHEET_PATH, (c) =>
    c.body(KIWA_STYLESHEET, 200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": IMMUTABLE_ASSET_CACHE_CONTROL,
    }),
  );

  /**
   * カード画面のアイランド（#338）。
   *
   * **CSS と同じ扱い。** URL に内容ハッシュが入るので `immutable` で
   * 配信してよい。中身は全利用者に同じスクリプトで、個人情報を 1 文字も
   * 含まない（カード ID は HTML 側の `data-card-id` から読む）。
   */
  app.get(ISLAND_PATH, (c) =>
    c.body(CARDS_ISLAND_JS, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": IMMUTABLE_ASSET_CACHE_CONTROL,
    }),
  );

  app.get(path, pageSecurityHeaders, async (c) => {
    const result = await c
      .get("container")
      .useCases.listMyCards.execute(getCookie(c, sessionCookieName(c.env.ENVIRONMENT)));

    if (!result.ok) {
      // `unauthenticated` だけをログインへ送る。identity_unavailable を
      // 混ぜると、auth-worker が落ちているときに利用者が延々と
      // ログインし直す羽目になる（ログインも同じ Worker が受けている）。
      if (result.failure.kind === "unauthenticated") {
        // 戻り先を載せる。素の `/login` へ送ると、ログインしたあと
        // 利用者が自分でこの画面まで辿り直すことになる。値の妥当性は
        // auth-worker の `sanitizeReturnTo` が判断する（関門は 1 つ）。
        return c.redirect(loginUrlWithReturnTo(returnToForCurrentRequest(c.req.url)), 302);
      }
      return c.text("しばらくしてからもう一度お試しください。", 503);
    }

    // キャッシュしない。カードの状態は所有者固有で、共有キャッシュに
    // 載ると他人に見える（#125 と同じ理由）。
    c.header("Cache-Control", "no-store");
    return c.html(<CardsPage cards={result.value} />);
  });
}
