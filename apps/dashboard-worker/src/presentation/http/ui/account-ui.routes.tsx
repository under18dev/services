import { sessionCookieName } from "@u18/contracts";
import { pageSecurityHeaders } from "@u18/web-ui";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { IdentityFailure } from "../../../domain/errors";
import type { AppBindings } from "../types";
import { GrantsPage, PasskeysPage, ProfilePage, SessionsPage } from "./pages";

/**
 * アカウント管理の画面（仕様書 §1.3「アカウント UI」/ §2.2「設定 UI」）。
 *
 * ## `registerRoutes` のチェーンには入れない
 *
 * `hono/client` の `hc<DashboardAppType>` はチェーンに積まれた型だけを見る。
 * **HTML を返す経路をそこへ混ぜると、型付きクライアントの補完に
 * 「JSON ではない経路」が並ぶ**ことになる。API（JSON）と画面（HTML）は
 * 呼ぶ側が違うので、登録も分ける。
 *
 * ## JS を 1 行も要求しない
 *
 * 表示だけに絞っている。失効・削除は既存の JSON API（Origin 検証つき）を
 * アイランドから叩く形で後続に回す。**form POST を並べない**のは、書き込み
 * 経路が 2 本になると 2 つを同期させ続ける必要が出るためで、本リポジトリで
 * 繰り返している「経路が違うと効かない」（#141 / #151 / #164）がそのまま
 * 再現する。
 */

/**
 * 取得に失敗したときの画面側の応答。**1 箇所に置く。**
 *
 * 画面ごとに書くと、**次に足した画面だけ 401 の JSON を出す**という形に
 * なる（本リポジトリで繰り返している「経路が違うと効かない」の UI 版）。
 *
 * **`unauthenticated` だけをログインへ送る。** `identity_unavailable` を
 * 混ぜると、auth-worker が落ちているときに利用者が延々とログインし直す
 * 羽目になる —— ログインも同じホストの auth-worker が受けているため。
 * 「認証が必要」と「認証基盤が落ちている」を畳むと、利用者が解決できない
 * 動作を繰り返す。
 */
function failureResponse(c: Context<AppBindings>, failure: IdentityFailure): Response {
  if (failure.kind === "unauthenticated") return toLogin(c);
  return c.text("しばらくしてからもう一度お試しください。", 503);
}

/**
 * ログイン画面へ送る。
 *
 * `getProfile` は**セッションが無効なときに `ok` のまま `null`** を返す
 * （存在しないこと自体はエラーではない、という RPC 契約）ので、
 * 失敗していなくてもここへ来る経路がある。
 */
function toLogin(c: Context<AppBindings>): Response {
  return c.redirect("/login", 302);
}

/*
 * `Cache-Control: no-store` をここで付けていない。
 *
 * **ミドルウェアが既定で付けている**（#125）。画面側でも明示しようとして
 * revert 確認をしたところ、**外しても 1 件も落ちなかった** —— つまり
 * 死にコードだった。「念のため二重に書く」は、本リポジトリが繰り返し
 * 踏んでいる「2 箇所を同期させ続ける」形そのものなので置かない。
 *
 * 付いていること自体はテストで固定してある。
 */

export function registerAccountUiRoutes(app: Hono<AppBindings>): void {
  const token = (c: Context<AppBindings>): string =>
    getCookie(c, sessionCookieName(c.env.ENVIRONMENT)) ?? "";

  app.get("/", pageSecurityHeaders, async (c) => {
    const result = await c.get("identity").getProfile(token(c));
    if (!result.ok) return failureResponse(c, result.failure);
    if (result.value === null) return toLogin(c);
    return c.html(<ProfilePage profile={result.value} />);
  });

  app.get("/sessions", pageSecurityHeaders, async (c) => {
    const result = await c.get("identity").listSessions(token(c));
    if (!result.ok) return failureResponse(c, result.failure);
    return c.html(<SessionsPage sessions={result.value} />);
  });

  app.get("/passkeys", pageSecurityHeaders, async (c) => {
    const result = await c.get("identity").listPasskeys(token(c));
    if (!result.ok) return failureResponse(c, result.failure);
    return c.html(<PasskeysPage passkeys={result.value} />);
  });

  app.get("/grants", pageSecurityHeaders, async (c) => {
    const result = await c.get("identity").listGrants(token(c));
    if (!result.ok) return failureResponse(c, result.failure);
    return c.html(<GrantsPage grants={result.value} />);
  });
}
