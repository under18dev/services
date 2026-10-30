import { sessionCookieName } from "@u18/contracts";
import { IMMUTABLE_ASSET_CACHE_CONTROL, pageSecurityHeaders } from "@u18/web-ui";
import { ACCOUNT_ISLAND_JS } from "./generated/account-island.bundle";
import { KIWA_STYLESHEET } from "./generated/kiwa-stylesheet";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { IdentityAdminGateway, IdentityOutcome } from "../../../application/ports";
import type { IdentityFailure } from "../../../domain/errors";
import type { AppBindings } from "../types";
import { HomePage } from "./home-page";
import {
  ADMIN_AUDIT_ROUTE,
  ADMIN_AUDIT_SEARCH_ROUTE,
  ADMIN_CLIENTS_CREATE_ROUTE,
  ADMIN_USERS_ACTION_ROUTE,
  ADMIN_USERS_ROUTE,
  ADMIN_USERS_SEARCH_ROUTE,
  ADMIN_CLIENTS_DISABLE_ROUTE,
  ADMIN_CLIENTS_ROUTE,
  APPS_ROUTE,
  GRANTS_ROUTE,
  ISLAND_ROUTE,
  KIWA_STYLESHEET_ROUTE,
  OVERVIEW_ROUTE,
  PASSKEYS_ROUTE,
  PROFILE_ROUTE,
  SESSIONS_ROUTE,
} from "./asset-paths";
import { APP_CATALOG, buildAppCatalog } from "./app-catalog";
import { AppsPage } from "./apps-page";
import { GrantsPage } from "./grants-page";
import { PasskeysPage } from "./passkeys-page";
import { ProfilePage } from "./profile-page";
import { SignInRequiredPage, UnavailablePage } from "./message-page";
import { AdminClientsPage, AdminNotFoundPage, type CreatedClient } from "./admin-clients-page";
import { AdminUsersPage } from "./admin-users-page";
import { AdminAuditPage } from "./admin-audit-page";
import { CSRF_FIELD_NAME, ensureCsrfToken, isValidCsrf, rotateCsrfToken } from "../csrf";
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
    const [flags, profile, passkeys, sessions, grants] = await Promise.all([
      navFlags(c, token),
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
        isAdmin={flags.isAdmin}
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

    const [flags, profile] = await Promise.all([
      navFlags(c, token),
      c.get("identity").getProfile(token),
    ]);
    if (!profile.ok) return renderFailure(c, profile);
    if (profile.value === null) return signInRequired(c);

    return c.html(<ProfilePage profile={profile.value} isAdmin={flags.isAdmin} />);
  })

  .get(PASSKEYS_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const [flags, passkeys] = await Promise.all([
      navFlags(c, token),
      c.get("identity").listPasskeys(token),
    ]);
    if (!passkeys.ok) return renderFailure(c, passkeys);

    return c.html(<PasskeysPage passkeys={passkeys.value} isAdmin={flags.isAdmin} />);
  })

  .get(SESSIONS_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const [flags, sessions] = await Promise.all([
      navFlags(c, token),
      c.get("identity").listSessions(token),
    ]);
    if (!sessions.ok) return renderFailure(c, sessions);

    return c.html(<SessionsPage sessions={sessions.value} isAdmin={flags.isAdmin} />);
  })

  .get(GRANTS_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const [flags, grants] = await Promise.all([
      navFlags(c, token),
      c.get("identity").listGrants(token),
    ]);
    if (!grants.ok) return renderFailure(c, grants);

    return c.html(<GrantsPage grants={grants.value} isAdmin={flags.isAdmin} />);
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

    const [flags, grants] = await Promise.all([
      navFlags(c, token),
      c.get("identity").listGrants(token),
    ]);
    if (!grants.ok && grants.failure.kind === "unauthenticated") return renderFailure(c, grants);

    // `null` は「取れなかった」。**「連携が 0 件」と同じ値にしないこと。**
    return c.html(
      <AppsPage
        view={buildAppCatalog(APP_CATALOG, grants.ok ? grants.value : null)}
        isAdmin={flags.isAdmin}
      />,
    );
  })

  /**
   * 利用者の一覧（#375 / #382）。**管理者だけ。**
   *
   * ## GET は絞り込みを受け取らない
   *
   * **検索語がメールアドレスになる。** クエリに置くと履歴にも Referer にも
   * `csrf.ts` の拒否ログ（`pathname`）にも残りうるので、**絞り込みと
   * 続きの読み込みは POST 側**（`ADMIN_USERS_SEARCH_ROUTE`）に置いた。
   * ここは「新しい順の先頭」だけを返す。
   *
   * ブックマークできなくなるが、**管理画面の検索結果はブックマークして
   * よいものではない。**
   */
  .get(ADMIN_USERS_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    return renderAdminUsers(c, token, {});
  })

  /**
   * 絞り込みと、続きの読み込み（#375）。
   *
   * **更新系ではないが POST である。** 理由は上の JSDoc。CSRF の判定は
   * 置いてある —— **第三者のページから検索を走らせる意味は薄いが、
   * 「POST を受ける口は守る」を例外付きにしたくない。** 例外を 1 つ作ると、
   * 次に足す人が「ここも読み取りだから」と広げる。
   */
  .post(ADMIN_USERS_SEARCH_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const form = await c.req.parseBody();
    if (!isValidCsrf(c, field(form, CSRF_FIELD_NAME))) {
      return renderAdminUsers(c, token, { error: CSRF_REJECTED_MESSAGE });
    }

    const query = (field(form, "query") ?? "").trim();
    const cursor = (field(form, "cursor") ?? "").trim();

    return renderAdminUsers(c, token, {
      ...(query === "" ? {} : { query }),
      ...(cursor === "" ? {} : { cursor }),
    });
  })

  /**
   * 利用者への操作（#375 / #382）。**停止・解除・セッションの失効。**
   *
   * ## 1 本の口にまとめてある
   *
   * 画面の form が `action` を押し分ける。**経路ごとに `isAdmin` の確認を
   * 書き分けない** —— 管理の経路が散ると、片方だけ忘れた状態が作れる。
   *
   * ## 守っているのはここではない
   *
   * 管理者判定も再認証も自分自身かどうかも、**auth-worker の UseCase が
   * 見ている。** ここは「どの操作を頼むか」を決めて、返ってきたものを
   * 人が読む文に訳すだけである。
   *
   * ## 一覧へ戻さない（PRG を挟まない）
   *
   * 戻すと「いま何をしたか」を次の GET へ運ぶ必要が出る。再読み込みで
   * 再送されるが、**停止も解除も状態を見てから書く**（`setStatus` の
   * `from`）ので、2 度目は `conflict` になって状態は動かない。
   */
  .post(ADMIN_USERS_ACTION_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const form = await c.req.parseBody();
    if (!isValidCsrf(c, field(form, CSRF_FIELD_NAME))) {
      return renderAdminUsers(c, token, { error: CSRF_REJECTED_MESSAGE });
    }

    const userId = (field(form, "user_id") ?? "").trim();
    const action = field(form, "action");
    const admin = c.get("identityAdmin");

    const outcome =
      action === "suspend"
        ? await suspendFromForm(admin, token, userId, field(form, "reason"))
        : action === "reinstate"
          ? await admin.reinstateUser(token, userId)
          : action === "revoke_sessions"
            ? await admin.revokeUserSessions(token, userId)
            : null;

    if (outcome === null) {
      return renderAdminUsers(c, token, { error: "操作を選んでください。" });
    }
    if (!outcome.ok) {
      if (outcome.failure.kind === "unauthenticated") return renderFailure(c, outcome);
      if (outcome.failure.kind === "not_found") return c.html(<AdminNotFoundPage />, 404);
      return renderAdminUsers(c, token, { error: manageFailureMessage(action, outcome.failure) });
    }

    // 権限の境界をまたぐ操作が通ったので、トークンを入れ替える。
    rotateCsrfToken(c);
    return renderAdminUsers(c, token, { notice: manageNotice(action, outcome.value) });
  })

  /**
   * 監査ログの閲覧（#375 / #382）。**管理者だけ。**
   *
   * `ADMIN_USERS_ROUTE` と同じ形 —— GET は絞り込みを受け取らず、
   * 絞り込みと続きの読み込みは POST の本文で渡す。
   */
  .get(ADMIN_AUDIT_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    return renderAdminAudit(c, token, {});
  })

  /** 絞り込みと、続きの読み込み（#375）。 */
  .post(ADMIN_AUDIT_SEARCH_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const form = await c.req.parseBody();
    if (!isValidCsrf(c, field(form, CSRF_FIELD_NAME))) {
      return renderAdminAudit(c, token, { error: CSRF_REJECTED_MESSAGE });
    }

    const event = (field(form, "event") ?? "").trim();
    const userId = (field(form, "user_id") ?? "").trim();
    const cursor = (field(form, "cursor") ?? "").trim();
    const outcomeRaw = field(form, "outcome");
    const outcome = outcomeRaw === "success" || outcomeRaw === "failure" ? outcomeRaw : undefined;

    return renderAdminAudit(c, token, {
      ...(event === "" ? {} : { event }),
      ...(userId === "" ? {} : { userId }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(cursor === "" ? {} : { cursor }),
    });
  })

  /**
   * OAuth クライアントの管理（#308 / #333）。**管理者だけ。**
   *
   * ## 守っているのはここではない
   *
   * 管理者でないセッションには auth-worker が `not_found` を返す
   * （`application/use-cases/admin-access.ts`）。**この画面はその答えを
   * 人が読む形にしているだけ**で、ここを迂回しても通らない。
   *
   * `isAdmin` を見て先に弾く形にはしていない。**判定が 2 か所になると、
   * 片方だけが古くなる** —— #337 で `isAdmin` の意味が「旗が立っている」
   * から「このセッションで管理者として振る舞ってよい」へ変わったとき、
   * 画面側に写しを持っていたらそこだけ古い意味で弾き続けた。
   *
   * ## `not_found` は 404 で返す
   *
   * 503（`UnavailablePage`）に畳むと、**管理者でない人には「いまは
   * 見られない」と読める** —— あとで見られるようになると思わせない。
   */
  .get(ADMIN_CLIENTS_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const [flags, clients] = await Promise.all([
      navFlags(c, token),
      c.get("identityAdmin").listOAuthClients(token),
    ]);
    if (!clients.ok) return renderAdminFailure(c, clients);

    return c.html(
      <AdminClientsPage
        isAdmin={flags.isAdmin}
        csrfToken={ensureCsrfToken(c)}
        clients={clients.value}
      />,
    );
  })

  /**
   * クライアントの登録（#308 / #333）。
   *
   * ## リダイレクトしない
   *
   * **`client_secret` の平文は、この応答にしか存在しない。** PRG を挟むと
   * 次の GET へ運ぶ必要があり、クエリにもパスにも Cookie にも置けない。
   * 200 でそのまま描く。
   *
   * **再読み込みで再送される。** `client_id` は自動生成（運用者の判断、
   * 2026-10-30）なので、以前のように「2 件目は `conflict` になるから
   * `Idempotency-Key` は要らない」とは言えなくなった —— 再送信のたびに
   * 違う ID の行ができうる。**それでも対策は入れていない。** 登録は
   * 管理者だけが叩く稀な操作で、重複に気づいたら片方を失効させれば
   * 済むため、新しい状態保持の仕組みを足すほどの見合いが無いと判断した
   * （契約側 `createOAuthClientInputSchema` の JSDoc も参照）。
   *
   * ## 失敗しても一覧は出す
   *
   * 入力を直してやり直す画面なので、**一覧ごと消さない。** 一覧が取れない
   * ときだけ失敗の画面へ回す。
   */
  .post(ADMIN_CLIENTS_CREATE_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const form = await c.req.parseBody();
    if (!isValidCsrf(c, field(form, CSRF_FIELD_NAME))) {
      // **障害時の文言と別にする。** どちらも「もう一度お試しください」に
      // していたので、**CSRF で弾いたのか RPC が落ちたのかを応答から
      // 区別できなかった** —— 判定を丸ごと外しても検査が緑のままになる
      // （#333 のネガティブ確認で出た）。
      return renderAdminPage(c, token, { error: CSRF_REJECTED_MESSAGE });
    }

    const redirectUris = (field(form, "redirect_uris") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const scopes = (field(form, "scopes") ?? "")
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter((scope) => scope !== "");
    const logoUrl = (field(form, "logo_url") ?? "").trim();
    const clientType = field(form, "client_type");

    if (clientType !== "confidential" && clientType !== "public") {
      return renderAdminPage(c, token, { error: "種別を選んでください。" });
    }

    const created = await c.get("identityAdmin").createOAuthClient(token, {
      name: (field(form, "name") ?? "").trim(),
      clientType,
      redirectUris,
      // **空なら渡さない。** 空配列を渡すと「0 個の scope を要求した」に
      // なり、既定（openid profile email）が効かない。
      ...(scopes.length === 0 ? {} : { scopes }),
      ...(logoUrl === "" ? {} : { logoUrl }),
    });

    if (!created.ok) {
      if (created.failure.kind === "unauthenticated") return renderFailure(c, created);
      if (created.failure.kind === "not_found") return c.html(<AdminNotFoundPage />, 404);
      return renderAdminPage(c, token, { error: createFailureMessage(created.failure.kind) });
    }

    // 権限の境界をまたぐ操作が通ったので、トークンを入れ替える
    // （auth-worker がログイン後に回しているのと同じ考え方）。
    rotateCsrfToken(c);
    return renderAdminPage(c, token, { created: created.value });
  })

  /**
   * クライアントの失効（#308 / #333）。**冪等。**
   *
   * **秘密を返さないのでリダイレクトしてよい**が、していない ——
   * 失効は一覧の見た目が変わる操作で、**同じ画面を描き直すほうが
   * 「何が変わったか」が見える。** 再読み込みで再送されても、
   * 2 度目は `disabled: false` になるだけで状態は動かない。
   */
  .post(ADMIN_CLIENTS_DISABLE_ROUTE, pageSecurityHeaders, async (c) => {
    const token = getCookie(c, sessionCookieName(c.env.ENVIRONMENT));
    if (token === undefined) return signInRequired(c);

    const form = await c.req.parseBody();
    if (!isValidCsrf(c, field(form, CSRF_FIELD_NAME))) {
      return renderAdminPage(c, token, { error: CSRF_REJECTED_MESSAGE });
    }

    const result = await c
      .get("identityAdmin")
      .disableOAuthClient(token, (field(form, "client_id") ?? "").trim());

    if (!result.ok) {
      if (result.failure.kind === "unauthenticated") return renderFailure(c, result);
      if (result.failure.kind === "not_found") return c.html(<AdminNotFoundPage />, 404);
      return renderAdminPage(c, token, { error: disableFailureMessage(result.failure.kind) });
    }

    rotateCsrfToken(c);
    return renderAdminPage(c, token, {
      // **「失効しました」と言い切らない。** 冪等なので 2 度目は何も
      // 変わっておらず、`disabled: false` が返る。嘘にならない形にする。
      notice: result.value.disabled
        ? "失効させました。以後このクライアントでの新しい認可は通りません。"
        : "このクライアントは既に失効しています。",
    });
  })

  /**
   * Kiwa UI のスタイルシート（#332）。
   *
   * **この Worker が配信する唯一のスタイルシートである。** 6 枚とも
   * これを読む（手書きの `u18.css` は #332 の P1 で消した。理由は
   * `asset-paths.ts`）。
   *
   * CSS と JS と同じく全利用者に同じ中身で、個人情報を含まない。
   */
  .get(KIWA_STYLESHEET_ROUTE, (c) =>
    c.body(KIWA_STYLESHEET, 200, {
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
 * サイドバーの出し分けに要る値（#333）。
 *
 * **1 リクエストに 1 回だけ決める。** 画面ごとに取りに行くと、同じ応答の
 * 中でサイドバーと本文が違う判断を持ちうる。
 *
 * ## `getProfile` ではなく `getSession` から取る
 *
 * `UserProfile` にも `isAdmin` はあり、**同じ判定である**ことが
 * `identity.ts` に書いてある。それでもこちらを使うのは、
 * **6 枚のうち 4 枚が `getProfile` を呼んでいない**ためで、
 * 画面によって出どころが変わる形を作りたくない。
 * `SessionSummary` はメールアドレスも username も持たないので、
 * サイドバーの出し分けに要る最小でもある。
 *
 * ## 取れなければ「管理者ではない」に倒す
 *
 * RPC が落ちたときに**管理の節を出す**側へ倒すと、落ちている間だけ
 * 非管理者に管理の節が見える。**逆に倒すと、落ちている間だけ管理者の
 * サイドバーから管理の節が消える** —— どちらも実害は小さいが、
 * **見えてはいけないものが見える**ほうが悪い。
 *
 * **画面そのものは道連れにしない。** ここが失敗しても一覧は出せるので、
 * `renderFailure` へは回さない（`/account/apps` が `listGrants` の失敗で
 * 本体を落とさないのと同じ判断）。
 *
 * **これはサイドバーの話だけである。** `/account/admin` 配下が叩けるかは
 * **画面側が自分で確かめること** —— ここを通らない経路から来ても
 * 守られていなければならない。
 */
async function navFlags(
  c: Context<AppBindings>,
  token: string,
): Promise<{ readonly isAdmin: boolean }> {
  const session = await c.get("identity").getSession(token);
  return { isAdmin: session.ok && session.value !== null && session.value.isAdmin };
}

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

/**
 * CSRF で弾いたときの文言。**障害時の文言と重ねない。**
 *
 * **理由は何が壊れたかを応答から読めるようにするため**だけではない ——
 * 重ねると、**判定そのものを外しても検査が落ちなくなる。** RPC は
 * 呼ばれて失敗し、どちらの道も同じ文字列へ着く。
 */
const CSRF_REJECTED_MESSAGE =
  "操作を受け付けられませんでした。画面を開き直してからお試しください。";

/** form の値を 1 つ取り出す。ファイルが来たら無いものとして扱う。 */
function field(form: Record<string, unknown>, name: string): string | undefined {
  const value = form[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * 管理画面を描き直す。**更新系の 2 本が共有する。**
 *
 * **一覧をもう一度引く。** 直前の操作の結果を手で足すのではなく、
 * auth-worker にもう一度聞く —— 足す形だと、**登録に成功したのに
 * 一覧へ出ない**（あるいはその逆）という食い違いが作れる。
 */
async function renderAdminPage(
  c: Context<AppBindings>,
  token: string,
  extra: { created?: CreatedClient; error?: string; notice?: string },
): Promise<Response> {
  const [flags, clients] = await Promise.all([
    navFlags(c, token),
    c.get("identityAdmin").listOAuthClients(token),
  ]);
  if (!clients.ok) return renderAdminFailure(c, clients);

  return c.html(
    <AdminClientsPage
      isAdmin={flags.isAdmin}
      csrfToken={ensureCsrfToken(c)}
      clients={clients.value}
      {...(extra.created === undefined ? {} : { created: extra.created })}
      {...(extra.error === undefined ? {} : { error: extra.error })}
      {...(extra.notice === undefined ? {} : { notice: extra.notice })}
    />,
  );
}

/**
 * 停止の form から理由を取り出して呼ぶ。
 *
 * **理由が無ければ RPC を呼ばない。** 契約の `z.enum` が弾くが、
 * **その失敗は `invalid_input` になって「障害」として画面に出る** ——
 * 選び忘れは利用者の操作なので、やり直せる文で返す。
 */
async function suspendFromForm(
  admin: IdentityAdminGateway,
  token: string,
  userId: string,
  reason: string | undefined,
): Promise<IdentityOutcome<{ revokedSessions: number }> | null> {
  if (reason !== "compromise" && reason !== "abuse") return null;
  return admin.suspendUser(token, userId, reason);
}

/** 通ったときの 1 文。**何が起きたかだけを言う。** */
function manageNotice(action: string | undefined, value: unknown): string {
  if (action === "suspend") {
    const revoked = (value as { revokedSessions?: number }).revokedSessions ?? 0;
    // **「切ったから止まる」と書かない。** 停止した時点で次の要求から
    // 通らなくなる（`GetSessionUseCase` が `isActive` を見る）。
    return `停止しました。ログイン中だった ${revoked} 件の端末も切りました。`;
  }
  if (action === "reinstate") return "停止を解除しました。またログインできます。";
  const revoked = (value as { revokedSessions?: number }).revokedSessions ?? 0;
  // **「ログインできなくなります」とは書かない。** 止めていないので、
  // 本人はログインし直せる。
  return `${revoked} 件の端末を切りました。本人はログインし直せます。`;
}

/** 通らなかった理由。**内部の事情は書かない。** */
function manageFailureMessage(action: string | undefined, failure: IdentityFailure): string {
  if (failure.kind === "reauthentication_required") {
    return "この操作にはログインし直しが必要です。もう一度ログインしてから操作してください。";
  }
  if (failure.kind === "conflict") {
    if (action === "suspend") {
      // **区別しない。** 既に停止済み・退会済み・`deleted`・自分自身 ——
      // auth-worker がどれも `conflict` に畳んでいる（存在を当てさせない）。
      return "停止できませんでした。すでに停止しているか、自分のアカウントです。";
    }
    if (action === "reinstate") {
      return "解除できませんでした。停止中ではないか、個人情報を削除済みのアカウントです。";
    }
  }
  return "いま操作できません。しばらく待ってからもう一度お試しください。";
}

/**
 * 監査ログの一覧を描く（#375）。**GET と POST が共有する。**
 */
async function renderAdminAudit(
  c: Context<AppBindings>,
  token: string,
  options: {
    event?: string;
    userId?: string;
    outcome?: "success" | "failure";
    cursor?: string;
    error?: string;
  },
): Promise<Response> {
  const [flags, page] = await Promise.all([
    navFlags(c, token),
    c.get("identityAdmin").listAuditLogs(token, {
      ...(options.event === undefined ? {} : { event: options.event }),
      ...(options.userId === undefined ? {} : { userId: options.userId }),
      ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    }),
  ]);
  if (!page.ok) return renderAdminFailure(c, page);

  return c.html(
    <AdminAuditPage
      isAdmin={flags.isAdmin}
      csrfToken={ensureCsrfToken(c)}
      entries={page.value.entries}
      nextCursor={page.value.nextCursor}
      {...(options.event === undefined ? {} : { event: options.event })}
      {...(options.userId === undefined ? {} : { userId: options.userId })}
      {...(options.outcome === undefined ? {} : { outcome: options.outcome })}
      {...(options.error === undefined ? {} : { error: options.error })}
    />,
  );
}

/**
 * 利用者の一覧を描く（#375）。**GET と POST が共有する。**
 *
 * **検索語を画面へ戻す。** 戻さないと、POST のあと入力欄が空になり、
 * 「続きを読む」が何の続きなのか分からなくなる。
 */
async function renderAdminUsers(
  c: Context<AppBindings>,
  token: string,
  options: { query?: string; cursor?: string; error?: string; notice?: string },
): Promise<Response> {
  const [flags, profile, page] = await Promise.all([
    navFlags(c, token),
    // **自分の `userId` が要る。** 自分の行に停止を出さないため
    // （守っているのは auth-worker。ここは押せるのに断られる形を避ける）。
    c.get("identity").getProfile(token),
    c.get("identityAdmin").listUsers(token, {
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    }),
  ]);
  if (!page.ok) return renderAdminFailure(c, page);

  return c.html(
    <AdminUsersPage
      isAdmin={flags.isAdmin}
      actorUserId={profile.ok && profile.value !== null ? profile.value.id : ""}
      csrfToken={ensureCsrfToken(c)}
      users={page.value.users}
      nextCursor={page.value.nextCursor}
      {...(options.query === undefined ? {} : { query: options.query })}
      {...(options.error === undefined ? {} : { error: options.error })}
      {...(options.notice === undefined ? {} : { notice: options.notice })}
    />,
  );
}

/**
 * 管理画面が一覧を取れなかったときの応答。
 *
 * **`not_found` を 404 にするのがここだけの違いである。** 他の画面は
 * `not_found` を「一時的に表示できません」へ畳んでよい（利用者にできる
 * ことが無いので）が、ここでは **`not_found` が「管理者ではない」の
 * 畳んだ値**なので、503 にすると「あとで見られる」と読める。
 */
function renderAdminFailure(
  c: Context<AppBindings>,
  outcome: Extract<IdentityOutcome<unknown>, { ok: false }>,
): Response | Promise<Response> {
  if (outcome.failure.kind === "not_found") return c.html(<AdminNotFoundPage />, 404);
  return renderFailure(c, outcome);
}

/**
 * 登録が通らなかった理由を、人が読む 1 文にする。
 *
 * **内部の事情は書かない。** `identity_unavailable` の `detail` は画面に
 * 出さない（`message-page.tsx` と同じ判断）。
 */
function createFailureMessage(kind: IdentityFailure["kind"]): string {
  switch (kind) {
    case "conflict":
      return "その client_id は既に使われています。別の値で登録してください。";
    case "reauthentication_required":
      // **窓は 5 分**（`hasFreshAuthentication`）。盗んだ Cookie 1 枚で
      // 認可コードの宛先を登録されないための要求である（RR-21 の緩和 1）。
      return "登録にはログインし直しが必要です。もう一度ログインしてから操作してください。";
    case "forbidden":
      return "入力に問題があります。Redirect URI は https の絶対 URI で、1 行に 1 つ書いてください。";
    default:
      return "いま登録できません。しばらく待ってからもう一度お試しください。";
  }
}

/** 失効が通らなかった理由。**一次パーティは `conflict` で返る。** */
function disableFailureMessage(kind: IdentityFailure["kind"]): string {
  switch (kind) {
    case "conflict":
      return "u18 公式のクライアントは、この画面からは失効させられません。";
    case "reauthentication_required":
      return "失効にはログインし直しが必要です。もう一度ログインしてから操作してください。";
    default:
      return "いま失効させられません。しばらく待ってからもう一度お試しください。";
  }
}
