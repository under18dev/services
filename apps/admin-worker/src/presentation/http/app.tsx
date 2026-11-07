import { IMMUTABLE_ASSET_CACHE_CONTROL, pageSecurityHeaders } from "@u18/web-ui";
import { GOOGLE_SANS_FONT_BYTES } from "@u18/web-ui/google-sans-font";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { routePath } from "hono/route";
import { createContainer, type ContainerOverrides } from "../../composition/container";
import { hasPermission } from "../../domain/permissions";
import { requiredPermissionFor } from "./route-permissions";
import { buildAuthorizationUrl } from "../../oidc/authorize-url";
import {
  buildLoginStateCookie,
  buildSessionCookie,
  clearLoginStateCookie,
  clearSessionCookie,
  loginStateCookieName,
  sessionCookieName,
} from "./cookies";
import { verifyIdToken } from "../../oidc/id-token";
import { decodeLoginState, encodeLoginState } from "../../oidc/login-state";
import { deriveCodeChallenge, generateCodeVerifier, generateOpaqueValue } from "../../oidc/pkce";
import { sanitizeReturnTo } from "../../oidc/return-to";
import { createSessionToken, verifySessionToken } from "../../oidc/session";
import { exchangeAuthorizationCode } from "../../oidc/token-exchange";
import { registerApprovalsRoutes } from "./approvals.routes";
import { registerAuditRoutes } from "./audit.routes";
import { wantsJsonResponse } from "./origin";
import { registerClientsRoutes } from "./clients.routes";
import { registerNfcAnalyticsRoutes } from "./nfc-analytics.routes";
import { registerNfcCardDetailRoutes, registerNfcRoutes } from "./nfc.routes";
import { registerUsersRoutes } from "./users.routes";
import { resolveUserRefs } from "./user-refs";
import {
  GOOGLE_SANS_FONT_PATH,
  ISLAND_PATH,
  KIWA_STYLESHEET_PATH,
  KIWA_STYLESHEET_WITH_FONTS,
} from "./ui/asset-paths";
import { ADMIN_ISLAND_JS } from "./ui/generated/admin-island.bundle";
import { HomePage } from "./ui/home-page";
import { forbiddenPermission, MessagePage } from "./ui/message-page";
import { PendingPage } from "./ui/pending-page";
import type { AppBindings } from "./types";

/**
 * admin-worker の骨組み。
 *
 * ## 設計がここまでに 2 回変わっている
 *
 * 1. **当初**: `isAdmin` を admin-worker 側で持つ（#390 検討初期）
 * 2. **d5 案**: `admin` scope のクライアントだけが要求できる scope にし、
 *    毎リクエスト `access_token → oauth_tokens → sessions` へ遡って
 *    `isAdmin` を確かめる
 * 3. **いまの形（運用者の判断、2026-10-30 夜）**: **u18 Identity 側には
 *    何も足さない。** `admin.under18.dev` には**誰でも OIDC でログインできる**。
 *    「誰が管理画面を使ってよいか」は **admin-worker 自身が持つ承認リスト**
 *    で決める。最初の 1 人は CLI でゴリ押しする。
 *
 * **この骨組みが持つのは 3 の全体**——OIDC で「誰か」を確かめる部分と、
 * `@u18/admin-db` の承認リストで「使ってよいか」を確かめる部分の両方。
 * u18 Identity は「誰か」しか答えない——scope は `openid` のみで、
 * `admin` のようなクライアント限定の scope は要求しない。承認されて
 * いない人は `/pending` へ送られ、その先の画面は見えない。
 *
 * **最初の 1 人を入れる手段（CLI）は `scripts/admin-approval.mjs`。**
 * 画面からの承認はまだ無い——承認する側の画面（「誰が待っているか」の
 * 一覧）が無いので、2 人目以降もしばらくは CLI で入れることになる。
 *
 * ## `acr` を要求する（決定 8、#390）
 *
 * **管理者は Passkey のセッションでしか振る舞えない**という決定 8 は、
 * dashboard-worker / nfc-worker では auth-worker 自身の `getSession` が
 * 強制しているが、admin-worker は別ホストの Relying Party で auth-worker
 * の生のセッションを読めない。`IdentityAdminDelegatedRPC`
 * （`IDENTITY_ADMIN_DELEGATED`）は `sessionToken` を要求しない設計
 * （`requireAdminSession` 相当が auth-worker 側に無い）なので、
 * **決定 8 をここで引き受けないと、admin-worker 経由だけ再認証なしで
 * 利用者の停止・OAuth クライアントの登録ができる穴になる。**
 *
 * `/login` で `acr_values=passkey` を要求し、`/callback` で返ってきた
 * ID Token の `acr` を見る——`REQUIRED_ACR` を参照。**`acr_values` は
 * u18 Identity 側では強制にならない**（`prompt=none` と組んだときだけ）
 * ので、確認は必ずここ（RP 側）で行う。
 *
 * ## `return_to` は admin-worker の中だけで閉じる
 *
 * `@u18/contracts` の `RETURN_TO_PARAM` は auth-worker が受け取る値の
 * 取り決めで、dashboard / nfc が auth へログインを頼むときに使う。
 * ここでの `return_to` は **admin-worker 自身の `/login` が受け取るだけ**
 * で、auth-worker へは渡らない（auth 側には `state` / `nonce` しか渡さない）。
 * 別の語彙なので、同じ定数を使わない。
 */
const RETURN_TO_QUERY = "return_to";

/**
 * 要求する scope。**`openid` だけ。**
 *
 * 承認リストが「使ってよいか」を決めるので、u18 Identity 側に
 * `admin` のような特別な scope を要求する理由が無い——admin-worker は
 * u18 Identity から見ればただの OIDC クライアントの 1 つである。
 */
const SCOPE = "openid";

/**
 * u18 が定義する `acr` の水準（決定 8、#390）。
 *
 * auth-worker の `domain/services/amr.ts` の `ACR_PASSKEY` と同じ文字列。
 * **import できない**（別 Worker）ので複製してある——`_shared.ts` の
 * 複製と同じ判断で、1 語の定数が 2 箇所にあること自体のリスクより、
 * 依存を増やすことのリスクのほうが大きい。
 */
const REQUIRED_ACR = "passkey";

/**
 * セッションを要求しない経路。OIDC のラウンドトリップそのものと死活監視、
 * それに CSS（#447）——未ログインの画面（`/login` 失敗時の `/callback` 等）も
 * これを読むので、セッションより先に配らないと「ログイン画面自体が
 * スタイルを失う」ことになる。
 */
const PUBLIC_PATHS = new Set([
  "/health",
  "/login",
  "/callback",
  "/logout",
  KIWA_STYLESHEET_PATH,
  // 並べ替え・絞り込み・コピー・タブ・通知のアイランド（#470）。CSS と
  // 同じ理由——個人情報を含まず、全員に同じ中身を配る。
  ISLAND_PATH,
  // Google Sans（design-system 連携）。CSS が `@font-face` で参照するので、
  // CSS と同じ経路で読めないといけない——個人情報を含まず、全員に同じ
  // 中身を配る点も同じ。
  GOOGLE_SANS_FONT_PATH,
]);

/** 承認待ちの画面。ログイン済みだが承認リストに無い人の行き先。ガードの対象外。 */
const PENDING_PATH = "/pending";

export function createApp(overrides: ContainerOverrides = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>({ strict: false });

  app.use("*", async (c, next) => {
    c.set("container", createContainer(c.env, overrides));
    await next();
  });

  /**
   * セッションガード。**公開経路以外の全部に掛ける。**
   *
   * `/` 1 本だけに書いていた時期があったが、それだと**次に足す保護対象の
   * 画面（#391 以降）が、この判定を書き忘れたまま公開されうる**
   * ——`cards.routes.ts` が書き込み系の門番を `.use("*", ...)` で
   * 先に置いているのと同じ理由。まだ存在しない経路（Hono が 404 を返す
   * もの）にもこのガードは先に走るので、**未認証なら 404 の前に
   * ログインへ送られる。**
   *
   * ## 承認の確認も、同じ場所でする
   *
   * **毎リクエスト D1 を引く。** トークンに `approved` を焼き込んで
   * キャッシュする案は採らない——このリポジトリで何度も出てきた判断と
   * 同じで、権限は「いま持っているか」を都度確かめるものであり、
   * 剥奪がキャッシュの寿命ぶん遅れる形を作らない。
   *
   * `/pending` 自身はこのガードの対象外にしてある——未承認の人を
   * `/pending` へ送った**その応答自体**がガードを通ると、
   * 「未承認なら `/pending` へ」のループになる。
   *
   * ## JSON を期待している呼び出しには 302 を返さない（#461 レビュー）
   *
   * `POST /nfc/cards`（`scripts/nfc-burn.py` のような機械向け JSON API）
   * もこのガードの対象で、302 のままだと機械は `/login` / `/pending` の
   * HTML を 200 として受け取ってしまう。`wantsJsonResponse` が真なら
   * `401 { error: "unauthenticated" }` / `403 { error: "not_approved" }`
   * を返す（`origin.ts` の JSDoc を参照）。
   */
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (PUBLIC_PATHS.has(url.pathname)) return next();

    const container = c.get("container");
    const { env } = container;
    const token = getCookie(c, sessionCookieName(env.ENVIRONMENT));
    const session =
      token === undefined || env.SESSION_SECRET === undefined || env.SESSION_SECRET === ""
        ? null
        : await verifySessionToken(new TextEncoder().encode(env.SESSION_SECRET), token);

    if (session === null) {
      // **JSON を期待している呼び出しには 302 を返さない**（#461 レビュー）。
      // 機械が `/login` の HTML を 200 として受け取り、「何が起きたか
      // 分からない」失敗になることを避ける——`wantsJsonResponse` の JSDoc
      // を参照。
      if (wantsJsonResponse(c)) return c.json({ error: "unauthenticated" }, 401);
      const returnTo = sanitizeReturnTo(`${url.pathname}${url.search}`);
      return c.redirect(`/login?${RETURN_TO_QUERY}=${encodeURIComponent(returnTo)}`, 302);
    }

    if (url.pathname !== PENDING_PATH) {
      const approved = await container.approvals.isApproved(session.sub);
      if (!approved) {
        if (wantsJsonResponse(c)) return c.json({ error: "not_approved" }, 403);
        return c.redirect(PENDING_PATH, 302);
      }
    }

    c.set("session", session);
    return next();
  });

  /**
   * 操作ごとの権限ガード（#190）。**上のガードより後、各ルートより前。**
   *
   * ここまで来ているのは「承認済み」（または `/pending` 自身）だけ。
   * `/`・`/pending`・`PUBLIC_PATHS` はホームの概要や入口であって個別の
   * 操作を行わないので、対象外のまま通す。
   *
   * **宣言は `route-permissions.ts` の `ROUTE_PERMISSIONS` に 1 箇所だけ**
   * 持つ。ここでは判定しか書かない——判定を散らすと、ルートを足したのに
   * ここを書き忘れて緩いまま通る経路ができる。
   *
   * **マッチしたルートの「パターン」で引く。** 生のリクエストパス
   * （`/nfc/nfc_abc123/disable`）では対応表の `/nfc/:cardId/disable` に
   * 当たらない。Hono が解決したパターンを得るには、`c.req.routePath`
   * （非推奨）ではなく `hono/route` の `routePath(c, -1)` を使うこと——
   * **ミドルウェアの中で既定の `routePath(c)` を呼ぶと、ミドルウェア自身の
   * 登録パターン（`"/*"`）が返り、最終的に応答するハンドラのパターンは
   * `-1`（末尾）でしか取れない**（実測、Hono 4.13）。
   *
   * **対応表に無いルートに実際にマッチしたら 403（既定は拒否）。**
   * `test/route-permissions.test.ts` が「宣言の無いルートを足せない」こと
   * を CI で見るが、万一それをすり抜けても安全側に倒す。一方、
   * **どのルートにもマッチしていない（`routePath(c, -1)` が `"/*"`、
   * この自分自身の登録パターンのまま）場合は、ただの 404 として素通り
   * させる**——存在しないパスまで 403 にすると、タイプミスの URL が
   * 「権限が無い」と誤解される。
   *
   * **403 の応答は、呼び出し側が JSON を期待しているかで出し分ける**
   * （`wantsJsonResponse`、#461 と同じ考え方）。素の
   * `c.json({ error: "forbidden" }, 403)` を人がブラウザで踏むと、
   * 運用者の指示「人がブラウザで到達しうる経路は全部 Kiwa UI で作り込む」
   * に反する——`forbiddenPermission`（`ui/message-page.tsx`）が
   * 理由を出さず次の一手（ホームへ戻る）だけを示す。
   */
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (PUBLIC_PATHS.has(url.pathname)) return next();
    if (url.pathname === PENDING_PATH || url.pathname === "/") return next();

    const matchedPath = routePath(c, -1);
    if (matchedPath === "/*") return next(); // どのルートにもマッチしていない。404 は下流に任せる。

    const required = requiredPermissionFor(c.req.method, matchedPath);
    if (required === undefined) {
      // CI の二方向テストが本来ここを落とすはずの状態。すり抜けても拒否する。
      // **JSON を期待している呼び出し（#461）にだけ JSON を返す。** それ
      // 以外（ブラウザでの画面遷移）に素の JSON を見せない——運用者の指示
      // 「人がブラウザで到達しうる経路は全部 Kiwa UI で作り込む」。
      if (wantsJsonResponse(c)) return c.json({ error: "forbidden" }, 403);
      return forbiddenPermission(c);
    }

    const session = c.get("session");
    const container = c.get("container");
    const effective = await container.approvals.getEffectivePermissions(session.sub);
    if (effective === null || !hasPermission(effective, required)) {
      if (wantsJsonResponse(c)) return c.json({ error: "forbidden" }, 403);
      return forbiddenPermission(c);
    }

    return next();
  });

  /**
   * **`assets` を載せる（#479）。** ハッシュ付きアセットは `/audit`
   * `/clients` `/nfc/analytics`（ログイン後）しか参照しないので、
   * `scripts/smoke-asset-probe.sh` が未認証で引く `PROBE_PAGES`
   * （`/callback`）からは配信ルートの崩れに気づけない
   * （`EXTERNALLY_UNVERIFIABLE_ASSETS` の JSDoc を参照）。
   *
   * **`asset-paths.ts` の定数をそのまま並べる。** ページ側の `<link>` /
   * `<script src>` と同じ値を直接 import するので、ここだけが古い文字列を
   * 書き写して片方だけ更新される、ということが起きない。
   *
   * `/health` は未認証・`PUBLIC_PATHS` に既にある——ここに載せても
   * 新しく公開することにはならない（内容ハッシュ入りの配信パスは、
   * CSS のほうは既に誰でも HTML から読める）。
   */
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "u18-admin",
      assets: [KIWA_STYLESHEET_PATH, ISLAND_PATH, GOOGLE_SANS_FONT_PATH],
    }),
  );

  /**
   * Kiwa UI のスタイルシート（#447）。
   *
   * **配信ルートを 1 度も登録していなかった。** `KIWA_STYLESHEET_PATH` は
   * `<link>` から参照されるだけで（`ui/asset-paths.ts`）、それを実際に
   * 返す `app.get` がどこにも無く、全画面が素の HTML で描かれていた
   * （nfc-worker の `cards-ui.routes.tsx` と同じ形をここでも登録する）。
   *
   * URL に内容ハッシュが入っているので `immutable` で配信してよい。
   * `PUBLIC_PATHS` にも入れてある——セッションが無い `/callback` の
   * 失敗画面も、ログイン前の `/login` も、これを読む。
   */
  app.get(KIWA_STYLESHEET_PATH, (c) =>
    c.body(KIWA_STYLESHEET_WITH_FONTS, 200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": IMMUTABLE_ASSET_CACHE_CONTROL,
    }),
  );

  /**
   * サブセット済み Google Sans 本体（design-system 連携）。
   *
   * 上の CSS が `@font-face` の相対 URL で参照する（`ui/asset-paths.ts`）。
   * `PUBLIC_PATHS` にも入れてある——CSS が読めるところでは常にこれも
   * 読めないと、`font-display: swap` でフォールバックへ静かに落ちる。
   */
  app.get(GOOGLE_SANS_FONT_PATH, (c) =>
    c.body(GOOGLE_SANS_FONT_BYTES, 200, {
      "Content-Type": "font/woff2",
      "Cache-Control": IMMUTABLE_ASSET_CACHE_CONTROL,
    }),
  );

  /**
   * 並べ替え・絞り込み・コピー・タブ・通知のアイランド（#470）。
   *
   * URL に内容ハッシュが入っているので `immutable` で配信してよい
   * （`asset-paths.ts`）。`PUBLIC_PATHS` にも入れてある——セッション/権限の
   * 2 本のガードより先に通す必要がある。入れ忘れると、ログイン済みの
   * 運営がこのファイルを読むたびに 403 になる（宣言の無いルートは既定
   * 拒否のため）。
   */
  app.get(ISLAND_PATH, (c) =>
    c.body(ADMIN_ISLAND_JS, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": IMMUTABLE_ASSET_CACHE_CONTROL,
    }),
  );

  /**
   * ログイン開始。PKCE + state + nonce を作り、login-state Cookie へ
   * 積んで認可エンドポイントへ 302 する。
   */
  app.get("/login", async (c) => {
    const container = c.get("container");
    const { env } = container;

    const returnTo = sanitizeReturnTo(c.req.query(RETURN_TO_QUERY));
    const state = generateOpaqueValue();
    const nonce = generateOpaqueValue();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await deriveCodeChallenge(codeVerifier);

    const { doc } = await container.discovery.get();
    const redirectUri = `${env.ADMIN_ORIGIN}/callback`;
    const authorizationUrl = buildAuthorizationUrl({
      authorizationEndpoint: doc.authorization_endpoint,
      clientId: env.OIDC_CLIENT_ID,
      redirectUri,
      scope: SCOPE,
      state,
      nonce,
      codeChallenge,
      // **要求するだけでは決定 8 を守れない**（u18 Identity は
      // `prompt=none` と組まない限り強制しない）。`/callback` 側の
      // `REQUIRED_ACR` 確認と対で機能する。
      acrValues: REQUIRED_ACR,
    });

    const loginState = encodeLoginState({ state, nonce, codeVerifier, returnTo });
    c.header("Set-Cookie", buildLoginStateCookie(env.ENVIRONMENT, loginState), { append: true });
    c.header("Cache-Control", "no-store");
    return c.redirect(authorizationUrl, 302);
  });

  /**
   * 認可応答を受ける。
   *
   * ## 順序が効く
   *
   * **`state` の一致を、トークン交換より先に見る。** 先に交換してしまうと、
   * 一致しない要求のためにも auth-worker への往復を使うことになり、
   * 「認可コードを知っているだけの第三者」に token エンドポイントを
   * 叩かせる足がかりを与える。
   */
  app.get("/callback", pageSecurityHeaders, async (c) => {
    const container = c.get("container");
    const { env } = container;

    const fail = (reason: string) => {
      // **理由はログにだけ出す。** CSRF 判定（auth-worker の `csrf.ts`）と
      // 同じ方針——画面に出すと、攻撃者に何を直せばよいか教える。
      console.warn(JSON.stringify({ event: "admin.callback_rejected", reason }));
      c.header("Set-Cookie", clearLoginStateCookie(env.ENVIRONMENT), { append: true });
      c.header("Cache-Control", "no-store");
      // **見出しと本文で同じ文を 2 回言わない（#517）。** `title` が
      // 見出しとして出て、`message` は Card の中にもう一度大きく出る
      // ——本文側は「次の一手」だけを言う。理由を出さない方針（直後の
      // コメントの通り）はそのまま、#487 で `/approvals` の見出しと
      // ラベルの重複を消したのと同じ形。
      return c.html(
        <MessagePage
          title="ログインをやり直してください"
          message="下のボタンから、もう一度お試しください。"
          actionHref="/login"
          actionLabel="ログイン画面へ"
        />,
        400,
      );
    };

    if (c.req.query("error") !== undefined) {
      return fail(`authorize_error:${c.req.query("error")}`);
    }

    const code = c.req.query("code");
    const returnedState = c.req.query("state");
    if (code === undefined || returnedState === undefined) return fail("missing_code_or_state");

    const loginState = decodeLoginState(getCookie(c, loginStateCookieName(env.ENVIRONMENT)));
    if (loginState === null) return fail("no_login_state_cookie");
    if (loginState.state !== returnedState) return fail("state_mismatch");

    const { doc, jwks } = await container.discovery.get();

    let tokens;
    try {
      tokens = await exchangeAuthorizationCode({
        fetcher: container.fetcher,
        tokenEndpoint: doc.token_endpoint,
        code,
        redirectUri: `${env.ADMIN_ORIGIN}/callback`,
        codeVerifier: loginState.codeVerifier,
        clientId: env.OIDC_CLIENT_ID,
        clientSecret: env.OIDC_CLIENT_SECRET,
      });
    } catch (error) {
      return fail(
        `token_exchange_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let verified;
    try {
      verified = await verifyIdToken({
        idToken: tokens.idToken,
        jwks,
        issuer: doc.issuer,
        audience: env.OIDC_CLIENT_ID,
        nonce: loginState.nonce,
      });
    } catch (error) {
      return fail(`id_token_invalid:${error instanceof Error ? error.message : String(error)}`);
    }

    if (verified.acr !== REQUIRED_ACR) {
      // **`fail()` を使わない。** あちらは「理由を画面に出さない」
      // 方針（攻撃者に何を直せばよいか教えない）だが、これは攻撃ではなく
      // 本人がメール OTP でログインしただけである——「やり直せば直る」
      // ことを具体的に伝えるほうが親切で、何も漏らさない。
      console.warn(JSON.stringify({ event: "admin.callback_rejected", reason: "acr_not_met" }));
      c.header("Set-Cookie", clearLoginStateCookie(env.ENVIRONMENT), { append: true });
      c.header("Cache-Control", "no-store");
      return c.html(
        <MessagePage
          title="パスキーでのログインが必要です"
          message="この管理画面はパスキーでログインした場合のみ使えます。"
          actionHref="/login"
          actionLabel="パスキーでログインし直す"
        />,
        403,
      );
    }

    if (env.SESSION_SECRET === undefined || env.SESSION_SECRET === "") {
      // **secret が無ければ即落とす。** 無いまま進むと、後段の
      // `verifySessionToken` が空文字列を鍵として検証し、どんな署名でも
      // 通る形になりかねない——`jose` は空鍵を拒否するが、それに頼らず
      // ここで明示的に止める。
      return fail("session_secret_not_configured");
    }
    const secretBytes = new TextEncoder().encode(env.SESSION_SECRET);
    // `tokens.accessToken` はここでは使わない。**u18 Identity 側に何も
    // 足さない**新しい設計では、admin-worker は「誰か」が分かれば
    // 十分で、access_token をそれ以上の何かに解決する経路を持たない。
    const sessionToken = await createSessionToken(secretBytes, verified.sub);

    c.header("Set-Cookie", clearLoginStateCookie(env.ENVIRONMENT), { append: true });
    c.header("Set-Cookie", buildSessionCookie(env.ENVIRONMENT, sessionToken, 8 * 60 * 60), {
      append: true,
    });
    c.header("Cache-Control", "no-store");
    return c.redirect(loginState.returnTo, 303);
  });

  app.get("/logout", (c) => {
    const { env } = c.get("container");
    c.header("Set-Cookie", clearSessionCookie(env.ENVIRONMENT), { append: true });
    c.header("Cache-Control", "no-store");
    return c.redirect("/login", 302);
  });

  /**
   * 承認待ちの画面。
   *
   * **ガードの対象外**（上のミドルウェアを参照）。承認済みの人がここへ
   * 来たら意味が無いので、来たら `/` へ戻す——**ガードの外にあるので、
   * ここで自分から承認を確かめる。**
   */
  app.get(PENDING_PATH, pageSecurityHeaders, async (c) => {
    const container = c.get("container");
    const { env } = container;
    const token = getCookie(c, sessionCookieName(env.ENVIRONMENT));
    const session =
      token === undefined || env.SESSION_SECRET === undefined || env.SESSION_SECRET === ""
        ? null
        : await verifySessionToken(new TextEncoder().encode(env.SESSION_SECRET), token);

    if (session === null) {
      return c.redirect(`/login?${RETURN_TO_QUERY}=${encodeURIComponent(PENDING_PATH)}`, 302);
    }
    if (await container.approvals.isApproved(session.sub)) {
      return c.redirect("/", 302);
    }

    c.header("Cache-Control", "no-store");
    // **自分の `sub` を出す。** 最初の 1 人を承認リストへ入れる手段は
    // CLI（`admin-approval.mjs`）しか無く、CLI に渡す `sub` を知る方法が
    // この画面以外に無い——運用者表を直接引くか、別の管理者になって
    // 管理画面に入るかの 2 択しか残らず、どちらも筋が悪い。承認済みの
    // ホーム（下の `/` ハンドラ）が `sub` を出しているのに、未承認の
    // ここだけ出していなかった（出すべきなのは逆の側だった）。
    //
    // **`--super` は既定で付けない（#517）。** 以前はここの画面が、
    // 待っている人が何人目かに関わらず常に `--super` 付きのコマンドを
    // コピーボタン（#491）ごと出していた——2 人目以降の承認待ちの画面にも
    // 同じコマンドが出て、貼って実行すると super approver（全操作を
    // 無条件に行える `isSuperApprover`、`checkSuperApproverChange` が
    // バイパスの対象にする側）を渡してしまう。`/approvals` の「新規の
    // 承認は権限 0 から始まる」と食い違う、本番のバグだった。
    //
    // **「いま super approver が 1 人も居ないか」で判定する。**
    // `countSuperApprovers()` は締め出し防止（#190）のために元々ある
    // 読み取りで、ここでもそのまま使える——意味もちょうど合う。
    // super approver が 1 人も居なければ、`/approvals` 画面そのものが
    // 誰からも開けない（`APPROVAL_GRANT` を持つ人がまだ居ない）ので、
    // いま承認する相手を super approver にする以外に、この先 CLI を
    // 使わずに運用を続ける経路が無い。逆に 1 人でも居れば、その人が
    // `/approvals` から後続の権限を配れるので、既定は付けない。
    const needsSuperApprover = (await container.approvals.countSuperApprovers()) === 0;
    const superFlag = needsSuperApprover ? " --super" : "";
    const grantCommand =
      `node apps/admin-worker/scripts/admin-approval.mjs grant ` +
      `--sub ${session.sub} --actor <実行者>${superFlag} --remote`;
    return c.html(
      <PendingPage
        sub={session.sub}
        grantCommand={grantCommand}
        needsSuperApprover={needsSuperApprover}
      />,
    );
  });

  /**
   * ホーム。**画面はここに積む。**
   *
   * ここへ来る時点で、上のガードが承認済みであることを確かめている。
   */
  app.get("/", pageSecurityHeaders, async (c) => {
    const session = c.get("session");
    const container = c.get("container");

    // **塊ごとに独立して取る。** 1 つの RPC が失敗しても、他の塊と
    // 「サインイン情報」は出す——`Promise.allSettled` を使う。
    // `RpcResult` の `ok: false` は値として返るのでここでは reject しないが、
    // Service Binding 自体の失敗や例外は reject になる——`Promise.all` の
    // ままだと、その 1 件でホーム全体が 500 になる（運用者の指示「ホームを
    // 行き止まりにしない」に反する）。reject した塊は「いま取れません」
    // （`null`）に落とすだけで、残りは出す。
    const [nfc, clients, userCounts, audit] = await Promise.allSettled([
      container.nfcCards.countCards(),
      container.identityAdmin.countOAuthClients({ actorUserId: session.sub }),
      container.identityAdmin.countUsers({ actorUserId: session.sub }),
      container.identityAdmin.listAuditLogs({
        actorUserId: session.sub,
        category: "operator_action",
        limit: 5,
      }),
    ]);

    const recentAuditEntries =
      audit.status === "fulfilled" && audit.value.ok ? audit.value.value.entries : null;
    // **`allSettled` の塊には混ぜない**（#482、3b のレビュー指摘）。
    // `resolveUserRefs` は落ちても例外を投げず空の `Map` を返す
    // （`user-refs.ts` の冒頭）ので、`Promise.all` に混ぜても技術的には
    // 壊れないが、**「監査ログは取れたが名前解決が落ちた」を「監査ログ
    // ごと取れなかった」に畳んでしまう**読み方を避けるため、
    // 監査ログが取れたことを確かめたあとに別で呼ぶ。
    const userRefs =
      recentAuditEntries === null
        ? new Map()
        : await resolveUserRefs(
            container.identityAdmin,
            session.sub,
            recentAuditEntries.map((entry) => entry.userId),
          );

    c.header("Cache-Control", "no-store");
    return c.html(
      <HomePage
        sub={session.sub}
        nfcCounts={nfc.status === "fulfilled" && nfc.value.ok ? nfc.value.value : null}
        clientCount={
          clients.status === "fulfilled" && clients.value.ok ? clients.value.value : null
        }
        userCounts={
          userCounts.status === "fulfilled" && userCounts.value.ok ? userCounts.value.value : null
        }
        recentAuditEntries={recentAuditEntries}
        userRefs={userRefs}
      />,
    );
  });

  // NFC カードの管理（#382 / #390 決定 16 ③）。上のガードが既にセッション・
  // 承認済みであることを確かめている。
  registerNfcRoutes(app);
  // NFC の解析画面（#454）。同上。
  registerNfcAnalyticsRoutes(app);
  // カード 1 枚の詳細（#472）。**`registerNfcAnalyticsRoutes` より後に
  // 登録すること。** 先に登録すると、`/nfc/:cardId` が `/nfc/analytics` を
  // 吸ってしまい、解析画面が「カードが見つかりません」になる——Hono は
  // 登録順に照合する（`users.routes.tsx:310` 付近の同じ罠を参照）。
  registerNfcCardDetailRoutes(app);
  // 利用者の管理・監査ログの閲覧（#375 / #382 / #390 決定 16 ③）。同上。
  registerUsersRoutes(app);
  registerAuditRoutes(app);

  // OAuth クライアントの管理（#308 / #333 / #390 決定 16 ③ 段取り 3）。
  // 上のガードが既にセッション・承認済みであることを確かめている。
  registerClientsRoutes(app);

  // 承認者・権限の管理（#190）。上のガードに加え、操作ごとの権限ガード
  // （`route-permissions.ts` の `APPROVAL_GRANT`）がこの経路を守っている。
  registerApprovalsRoutes(app);

  return app;
}
