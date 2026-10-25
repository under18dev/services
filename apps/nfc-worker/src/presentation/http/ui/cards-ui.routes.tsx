import { sessionCookieName } from "@u18/contracts";
import { pageSecurityHeaders } from "@u18/web-ui";
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
  app.get(path, pageSecurityHeaders, async (c) => {
    const result = await c
      .get("container")
      .useCases.listMyCards.execute(getCookie(c, sessionCookieName(c.env.ENVIRONMENT)));

    if (!result.ok) {
      // `unauthenticated` だけをログインへ送る。identity_unavailable を
      // 混ぜると、auth-worker が落ちているときに利用者が延々と
      // ログインし直す羽目になる（ログインも同じ Worker が受けている）。
      if (result.failure.kind === "unauthenticated") return c.redirect("/login", 302);
      return c.text("しばらくしてからもう一度お試しください。", 503);
    }

    // キャッシュしない。カードの状態は所有者固有で、共有キャッシュに
    // 載ると他人に見える（#125 と同じ理由）。
    c.header("Cache-Control", "no-store");
    return c.html(<CardsPage cards={result.value} />);
  });
}
