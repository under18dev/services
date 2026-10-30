import { pageSecurityHeaders } from "@u18/web-ui";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createContainer, type ContainerOverrides } from "../../composition/container";
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
import { registerNfcRoutes } from "./nfc.routes";
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
 * ## `amr`（認証方法）クレームはまだ見ていない
 *
 * d5 が ID Token に `amr` を足す作業と並行している。`amr` が無いと、
 * admin-worker は「Passkey で入ったか、メール OTP で入ったか」を
 * 知る手段が無い——**承認リストへの昇格（誰かを承認してよい権限）に
 * Passkey を要求する**なら、`amr` が入ってから確かめる。いまは
 * 確かめていないことを、ここに明示しておく。
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

/** セッションを要求しない経路。OIDC のラウンドトリップそのものと死活監視。 */
const PUBLIC_PATHS = new Set(["/health", "/login", "/callback", "/logout"]);

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
      const returnTo = sanitizeReturnTo(`${url.pathname}${url.search}`);
      return c.redirect(`/login?${RETURN_TO_QUERY}=${encodeURIComponent(returnTo)}`, 302);
    }

    if (url.pathname !== PENDING_PATH) {
      const approved = await container.approvals.isApproved(session.sub);
      if (!approved) return c.redirect(PENDING_PATH, 302);
    }

    c.set("session", session);
    return next();
  });

  app.get("/health", (c) => c.json({ status: "ok", service: "u18-admin" }));

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
  app.get("/callback", async (c) => {
    const container = c.get("container");
    const { env } = container;

    const fail = (reason: string) => {
      // **理由はログにだけ出す。** CSRF 判定（auth-worker の `csrf.ts`）と
      // 同じ方針——画面に出すと、攻撃者に何を直せばよいか教える。
      console.warn(JSON.stringify({ event: "admin.callback_rejected", reason }));
      c.header("Set-Cookie", clearLoginStateCookie(env.ENVIRONMENT), { append: true });
      return c.text("ログインをやり直してください。", 400, { "Cache-Control": "no-store" });
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
    return c.html(
      "<!doctype html><html><body>" +
        "<p>ログインできました。使えるようにするには、承認の権限を持つ人に次の ID を伝えてください。</p>" +
        `<p>${renderSub(session.sub)}</p>` +
        "<p>（承認する人向け。最初の 1 人には <code>--super</code> が要ります）</p>" +
        `<pre><code>node apps/admin-worker/scripts/admin-approval.mjs grant --sub ${escapeHtml(session.sub)} --actor &lt;実行者&gt; --super --remote</code></pre>` +
        "</body></html>",
    );
  });

  /**
   * プレースホルダのホーム。**画面はここに積む。**
   *
   * ここへ来る時点で、上のガードが承認済みであることを確かめている。
   */
  app.get("/", pageSecurityHeaders, (c) => {
    const session = c.get("session");
    c.header("Cache-Control", "no-store");
    return c.html(
      `<!doctype html><html><body><p>サインインしました: ${renderSub(session.sub)}</p>` +
        `<p><a href="/nfc">NFC カード</a></p></body></html>`,
    );
  });

  // NFC カードの管理（#382 / #390 決定 16 ③）。上のガードが既にセッション・
  // 承認済みであることを確かめている。
  registerNfcRoutes(app);

  return app;
}

/**
 * `session.sub` を HTML へ埋め込む形を 1 箇所に揃える。
 *
 * 承認待ち（`/pending`）と承認済み（`/`）の両方がこれを呼ぶ。別々に
 * `escapeHtml` を呼ぶ形にすると、書式を変えたとき片方だけ直される——
 * このリポジトリで繰り返し踏んできた形（#369 の記録を参照）。
 */
function renderSub(sub: string): string {
  // `sub` は `newUserId()` の形（英数字と `_`）しか取らないはずだが、
  // ID Token の検証をすり抜けた値をそのまま HTML へ流し込む経路を
  // 作らないため、文字参照にしてから埋める。
  return `<code>${escapeHtml(sub)}</code>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
