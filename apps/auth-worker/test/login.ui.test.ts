import { hasAssetHash } from "@u18/web-ui";
import { SELF, env } from "cloudflare:test";
import { sessionCookieName } from "@u18/contracts";
import { createIdentityDatabase, users } from "@u18/db";
import { newId } from "@u18/domain";
import { aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { DrizzleEmailChallengeRepository } from "../src/infrastructure/persistence/drizzle-email-challenge.repository";
import { KIWA_STYLESHEET_PATH, LOGIN_ISLAND_PATH } from "../src/presentation/http/ui/asset-paths";
import { freshIpFactory } from "./fresh-ip";
import { resetDatabase } from "./helpers";

/**
 * ログイン画面（仕様書 14-1 の決定 4 / #36）を HTTP 越しに通す。
 *
 * ここでしか確かめられないのは 3 つ:
 *  1. JS 無し（ただの form POST）でメール OTP ログインが最後まで通ること
 *  2. CSRF トークンと Origin の両方が無いと更新系を受け付けないこと
 *  3. 応答から「そのアドレスが登録されているか」が分からないこと
 */

const BASE = "http://localhost";
const ORIGIN = "http://localhost:8787";

const REGISTERED = "taro@example.com";
const UNREGISTERED = "nobody@example.com";

const user = aUser({ email: REGISTERED, displayName: "山田 太郎", username: "taro" });

async function seedRegisteredUser(): Promise<void> {
  const db = createIdentityDatabase(env.IDENTITY_DB);
  await db
    .insert(users)
    .values({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      primaryEmail: user.email,
      emailVerified: user.emailVerified,
    })
    .run();
}

/**
 * 既知のコードでチャレンジを 1 件作る。
 *
 * 本物の送信経路（Cloudflare Email Sending）からコードは取り出せないので、
 * UseCase が作るのと同じ行を Repository 経由で直接入れる。
 */
async function seedOtpChallenge(email: string, code: string): Promise<void> {
  const repository = new DrizzleEmailChallengeRepository(createIdentityDatabase(env.IDENTITY_DB));
  await repository.create({
    id: newId("emc"),
    userId: null,
    email,
    codeHash: await new Sha256TokenHasher().hash(code),
    purpose: "login",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    maxAttempts: 5,
    sentAt: new Date(),
  });
}

/** Set-Cookie から `name=value` だけを取り出す。 */
function cookiePairs(response: Response): string[] {
  return response.headers.getSetCookie().map((raw) => raw.split(";")[0] ?? "");
}

function cookieHeader(pairs: string[]): string {
  return pairs.join("; ");
}

function csrfTokenOf(html: string): string {
  const match = /name="csrf_token" value="([^"]+)"/.exec(html);
  if (match?.[1] === undefined) throw new Error("CSRF トークンが描画されていない");
  return match[1];
}

type Session = { readonly cookie: string; readonly csrf: string; readonly html: string };

/** ログイン画面を開いた直後の状態（Cookie と CSRF トークン）を作る。 */
async function openLoginPage(cookie = ""): Promise<Session> {
  const response = await SELF.fetch(`${BASE}/login`, {
    headers: cookie === "" ? {} : { Cookie: cookie },
  });
  const html = await response.text();
  const issued = cookiePairs(response);
  const merged = cookie === "" ? issued : [cookie, ...issued];
  return { cookie: cookieHeader(merged), csrf: csrfTokenOf(html), html };
}

/**
 * 要求ごとに違う IP を名乗る。
 *
 * **このファイルは `/login/verify` を何度も叩く。** IP を共有していると
 * `email_verify`（15 / 60 秒）の枠をテスト同士で食い合い、**テストを 1 本
 * 足した人が無関係な 429 で落ちる。**
 *
 * **割り当ては `fresh-ip.ts` が 1 箇所で持っている。** ファイルごとに手で
 * レンジを選ぶ形だと、重なりに気づかないまま足せてしまう。
 */
const freshIp = freshIpFactory("login-ui");

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function submit(
  path: string,
  fields: Record<string, string>,
  options: { cookie?: string; origin?: string | null } = {},
): Promise<Response> {
  const { cookie, origin = ORIGIN } = options;
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": freshIp(),
      ...(origin === null ? {} : { Origin: origin }),
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body: form(fields),
  });
}

/**
 * ログインを 1 回通してセッション Cookie を得る。
 *
 * **呼ぶたびに別のセッションが 1 つ増える。** 「別の端末」を作るのに使う
 * （#208 の全端末ログアウト）。`seedRegisteredUser()` が済んでいること。
 */
async function login(): Promise<string> {
  const session = await openLoginPage();
  await seedOtpChallenge(REGISTERED, "123456");
  const verified = await submit(
    "/login/verify",
    { csrf_token: session.csrf, email: REGISTERED, code: "123456" },
    { cookie: session.cookie },
  );
  return cookieHeader(cookiePairs(verified));
}

describe("GET /login の描画", () => {
  beforeEach(resetDatabase);

  it("HTML とメールアドレスの form を返す", async () => {
    const response = await SELF.fetch(`${BASE}/login`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");

    const html = await response.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('action="/login/start"');
    expect(html).toContain('name="email"');
    // Passkey のボタン自体はアイランドが描く。サーバーが返すのはマウント先と、
    // JS が動かなかったときに残る代替表示だけ。
    expect(html).toContain('id="passkey-island"');
    // **ページが書く URL と配信ルートが一致していること**（#211）。
    // ハッシュが入るので文字列を書き写さない。
    expect(html).toContain(`src="${LOGIN_ISLAND_PATH}"`);
  });

  it("CSRF トークンを hidden と Cookie の両方に置く", async () => {
    const response = await SELF.fetch(`${BASE}/login`);
    const html = await response.text();
    const token = csrfTokenOf(html);

    const cookie = cookiePairs(response).find((pair) => pair.startsWith("u18_csrf="));
    expect(cookie).toBe(`u18_csrf=${token}`);

    // JS から読む必要がないので読めなくしておく。
    const raw = response.headers.getSetCookie().find((c) => c.startsWith("u18_csrf="));
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
  });

  it("CSP を足し、インラインスクリプトを 1 つも置かない", async () => {
    const response = await SELF.fetch(`${BASE}/login`);
    /**
     * **`Referrer-Policy` を `no-referrer` にしない。**
     *
     * Fetch 仕様では、referrer policy が参照元を落とすとき
     * **ナビゲーション要求の `Origin` も `null` になる**。自分のページから
     * 出した form 送信が `Origin: null` で届き、Origin 検証に落ちる。
     *
     * **本番で JS 無しの form 経路が全滅していた**（ログイン・新規登録・
     * ログアウト）。`Origin` を明示するテストしか無かったので気づけなかった。
     *
     * `same-origin` なら同一オリジンへの要求にだけ参照元が載る。外部へは
     * 何も送らないので、`redirect_uri` へ飛ぶときに認可 URL が RP へ漏れない
     * —— 守りたかったのはそちらで、それは保たれる。
     */
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");

    const csp = response.headers.get("Content-Security-Policy");

    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // 緩めて解決しない。'unsafe-inline' が混ざったらこのテストが落ちる。
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");

    // CSP に合わせて、スクリプトは必ず外部ファイル参照になっている。
    //
    // **正規表現で `<script...>` を拾わない**（CodeQL `js/bad-tag-filter`）。
    // 属性値に `>` を含むタグで切れるし、`[^>]*` の範囲外にある形を
    // 取りこぼすと、**インラインスクリプトがあるのにテストが通る**。
    // 「見ているつもりのものを見ていない」形になる。
    //
    // workerd には本物の HTML パーサ（`HTMLRewriter`）があるので、そちらで読む。
    const scripts: { src: string | null; body: string }[] = [];
    let current: { src: string | null; body: string } | null = null;
    await new HTMLRewriter()
      .on("script", {
        element(element) {
          current = { src: element.getAttribute("src"), body: "" };
          scripts.push(current);
        },
        text(chunk) {
          if (current !== null) current.body += chunk.text;
        },
      })
      .transform(response.clone())
      .text();

    expect(scripts.length, "script タグが 1 つも見つからない").toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script.src, "src の無い script がある").not.toBeNull();
      // 外部参照でも中身を書けてしまうので、空であることまで見る。
      expect(script.body.trim(), "インラインのスクリプト本体がある").toBe("");
    }
  });

  it("二度開いても CSRF トークンを作り直さない（タブを複数開いても壊れない）", async () => {
    const first = await openLoginPage();
    const second = await openLoginPage(first.cookie);
    expect(second.csrf).toBe(first.csrf);
  });
});

describe("CSP が許していないものを画面が使っていない", () => {
  /**
   * **ヘッダ側しか見ていなかった。** 上の CSP のテストは
   * `'unsafe-inline'` が**混ざっていない**ことを見る。混ざっていないのに
   * **使っている**側は誰も見ておらず、dashboard-worker がパネルの間隔を
   * `style` 属性で付けたまま本番へ出た（ブラウザが属性を捨て、枠線が
   * 密着した）。
   *
   * `style` 属性には CSP3 の `style-src-attr` が掛かり、無ければ
   * `style-src` へ落ちる。`style-src 'self'` なので属性ごと捨てられる。
   * **HTML も状態コードも正しいまま見た目だけが崩れる**ので、応答を
   * 見ているテストでは気づけない。
   *
   * ここは dashboard と**同じ CSP・同じスタイルシート**を使う側なので、
   * 片方にだけ検査を置くと、もう片方で同じことが起きる
   * （`apps/dashboard-worker/test/ui-pages.test.ts` に対の検査がある）。
   */
  it.each(["/login", "/signup"])("%s に style 属性も <style> も無い", async (path) => {
    const html = await (await SELF.fetch(`${BASE}${path}`)).text();

    expect(html, `${path} にインラインの style 属性がある`).not.toContain('style="');
    expect(html, `${path} に <style> がある`).not.toContain("<style");
  });
});

describe("URL に内容ハッシュが入る（#211）", () => {
  /**
   * **HTML に実際に書かれた URL を取りに行く。** 定数を 2 回使って
   * 突き合わせると「定数が自分自身と一致する」しか見ていない。
   *
   * ハッシュが外れても画面は動く（URL が固定に戻るだけ）ので、ここが
   * 唯一それに気づく場所である。外れると `immutable` と組み合わさって、
   * **内容を変えてもブラウザが 1 年古いものを使い続ける。**
   */
  const urlsIn = (page: string): string[] =>
    [...page.matchAll(/(?:src|href)="(\/ui\/[^"]*)"/g)].map((match) => match[1] ?? "");

  it.each(["/login", "/signup"])("%s が参照する URL", async (path) => {
    const urls = urlsIn(await (await SELF.fetch(`${BASE}${path}`)).text());
    expect(urls.length, "アセットを 1 つも参照していない").toBeGreaterThan(0);

    for (const url of urls) {
      expect(hasAssetHash(url), `${url} にハッシュが入っていない`).toBe(true);

      const response = await SELF.fetch(`${BASE}${url}`);
      expect(response.status, `${url} が引けない`).toBe(200);
      expect(response.headers.get("Cache-Control")).toContain("immutable");
    }
  });

  it("ハッシュの無い古い URL は 404 になる", async () => {
    // **これは正しい挙動。** デプロイ前の URL を掴んだブラウザは新しい
    // サーバーから取れない。代わりに、ページを読めば必ず新しい URL を
    // 指しているので取りに行ける。ここが 200 を返すなら古い URL も
    // 生かしていることになり、#211 で消した窓が戻る。
    expect((await SELF.fetch(`${BASE}/ui/kiwa.css`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/ui/login-island.js`)).status).toBe(404);
    // `u18.css` は**ハッシュ付きでももう存在しない**（#332 の P2 で
    // `styles.ts` ごと消した）。ハッシュの有無に関わらず 404 である。
    expect((await SELF.fetch(`${BASE}/ui/u18.css`)).status).toBe(404);
  });
});

describe("Auth UI のアセット配信", () => {
  it("スタイルシートを返す", async () => {
    const response = await SELF.fetch(`${BASE}${KIWA_STYLESHEET_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/css");
    expect((await response.text()).length).toBeGreaterThan(100);
  });

  it("Passkey アイランドの JS を返す", async () => {
    const response = await SELF.fetch(`${BASE}${LOGIN_ISLAND_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/javascript");

    const source = await response.text();
    expect(source).toContain("/api/auth/passkeys/login/options");
    // アカウント列挙を避けるため、ログインの Challenge 要求に識別子を渡さない
    // 設計（PasskeyLoginOptionsUseCase）と対になっている。候補を絞る方向へ
    // 変えたくなったら API ではなく UX を変えること。
    expect(source).not.toContain("allowCredentials");
  });
});

describe("CSRF: form POST は Origin とトークンの両方を要求する", () => {
  const paths = ["/login/start", "/login/verify", "/login/logout"];

  beforeEach(resetDatabase);

  it.each(paths)("%s は Origin が無ければ 403", async (path) => {
    const session = await openLoginPage();
    const response = await submit(
      path,
      { csrf_token: session.csrf, email: REGISTERED, code: "123456" },
      { cookie: session.cookie, origin: null },
    );
    expect(response.status).toBe(403);
  });

  it.each(paths)("%s は別オリジンを拒否する", async (path) => {
    const session = await openLoginPage();
    const response = await submit(
      path,
      { csrf_token: session.csrf, email: REGISTERED, code: "123456" },
      { cookie: session.cookie, origin: "https://evil.example" },
    );
    expect(response.status).toBe(403);
  });

  it.each(paths)("%s は CSRF トークンが違えば 403", async (path) => {
    const session = await openLoginPage();
    const response = await submit(
      path,
      { csrf_token: "x".repeat(43), email: REGISTERED, code: "123456" },
      { cookie: session.cookie },
    );
    expect(response.status).toBe(403);
  });

  it.each(paths)("%s は Cookie が無ければ 403（トークンだけでは通らない）", async (path) => {
    const session = await openLoginPage();
    const response = await submit(path, {
      csrf_token: session.csrf,
      email: REGISTERED,
      code: "123456",
    });
    expect(response.status).toBe(403);
  });

  it("拒否された場合もやり直せるよう、新しいトークンを載せた画面を返す", async () => {
    const response = await submit("/login/start", { email: REGISTERED });
    expect(response.status).toBe(403);

    const html = await response.text();
    expect(csrfTokenOf(html).length).toBeGreaterThan(0);
    // 理由は書かない。トークンが古いのか Origin が違うのかを教えない。
    expect(html).not.toContain("Origin");
  });
});

describe("メール OTP ログイン（JavaScript 無し）", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedRegisteredUser();
  });

  it("form POST だけでコード入力画面まで進む", async () => {
    const session = await openLoginPage();
    const response = await submit(
      "/login/start",
      { csrf_token: session.csrf, email: REGISTERED },
      { cookie: session.cookie },
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('action="/login/verify"');
    expect(html).toContain('name="code"');
    // 次の画面へメールアドレスを運ぶのは hidden。クエリには載せない。
    expect(html).toContain(`value="${REGISTERED}"`);
  });

  it("コードを正しく入れるとセッション Cookie が発行され、アカウント画面へ進む", async () => {
    const session = await openLoginPage();
    await seedOtpChallenge(REGISTERED, "123456");

    const verified = await submit(
      "/login/verify",
      { csrf_token: session.csrf, email: REGISTERED, code: "123456" },
      { cookie: session.cookie },
    );

    // 再読み込みで使用済みコードを送り直さないよう 303 にする。
    expect(verified.status).toBe(303);
    // **ログイン画面へは戻さない**（ui/landing.ts）。戻すと「ログイン済みです」
    // とだけ書かれた行き止まりに着地する。
    //
    // **行き先をここに書き写している。** `DEFAULT_LANDING_PATH` を import して
    // 突き合わせると、定数を書き換えたときにこの検査も一緒に動いてしまい、
    // **何を変えても緑のまま**になる。サインアップ側（signup.ui.test.ts）も
    // 同じ文字列を直接書いていて、2 つが同じ場所を指していることはその
    // 2 つの文字列が一致していることで決まる。
    expect(verified.headers.get("Location")).toBe("/account");

    const issued = cookiePairs(verified);
    const sessionCookie = issued.find((pair) =>
      pair.startsWith(`${sessionCookieName(env.ENVIRONMENT)}=`),
    );
    expect(sessionCookie).toBeDefined();

    const raw = verified.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${sessionCookieName(env.ENVIRONMENT)}=`));
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");

    // 権限が変わったので CSRF トークンも入れ替わっている。
    const rotated = issued.find((pair) => pair.startsWith("u18_csrf="));
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(`u18_csrf=${session.csrf}`);

    // 発行された Cookie で既存の API も通る。
    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: sessionCookie ?? "" } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: user.id });
  });

  it("OTP やトークンを URL へ載せない", async () => {
    const session = await openLoginPage();
    await seedOtpChallenge(REGISTERED, "123456");

    const verified = await submit(
      "/login/verify",
      { csrf_token: session.csrf, email: REGISTERED, code: "123456" },
      { cookie: session.cookie },
    );

    const location = verified.headers.get("Location") ?? "";
    expect(location).not.toContain("?");
    expect(location).not.toContain("123456");
    expect(location).not.toContain(REGISTERED);
  });

  it("戻り先が渡っていればそちらが既定より優先される", async () => {
    // **既定の着地点を足したとき、戻り先を上書きしていないこと。**
    // `returnTo ?? DEFAULT_LANDING_PATH` の左右を取り違えると、認可フローの
    // 途中でログインした人が `/oauth/authorize` へ戻らずアカウント画面へ
    // 着地する —— クライアントから見ると「ログインしたのに何も起きない」。
    const returnTo = "/oauth/authorize?client_id=demo&response_type=code";
    const session = await openLoginPage();
    await seedOtpChallenge(REGISTERED, "123456");

    const verified = await submit(
      "/login/verify",
      { csrf_token: session.csrf, email: REGISTERED, code: "123456", return_to: returnTo },
      { cookie: session.cookie },
    );

    expect(verified.status).toBe(303);
    expect(verified.headers.get("Location")).toBe(returnTo);
  });
});

describe("ログイン済みの状態で GET /login", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedRegisteredUser();
  });

  it("ログイン済みであることを示し、ログイン form を出さない", async () => {
    const cookie = await login();
    const response = await SELF.fetch(`${BASE}/login`, { headers: { Cookie: cookie } });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("ログイン済み");
    expect(html).toContain(user.displayName);
    expect(html).not.toContain('action="/login/start"');
    // ログイン済み画面に JS は要らない。読み込ませない。
    expect(html).not.toContain(LOGIN_ISLAND_PATH);
  });

  it("ログアウトすると Cookie が落ち、ログイン画面へ戻る", async () => {
    const cookie = await login();
    const page = await openLoginPage(cookie);

    const response = await submit(
      "/login/logout",
      { csrf_token: page.csrf },
      { cookie: page.cookie },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/login");

    const cleared = response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${sessionCookieName(env.ENVIRONMENT)}=`));
    expect(cleared).toContain("Max-Age=0");

    // 落とした Cookie では /api/me が通らない。
    const me = await SELF.fetch(`${BASE}/api/me`, {
      headers: { Cookie: cookieHeader(cookiePairs(response)) },
    });
    expect(me.status).toBe(401);
  });
});

/**
 * すべての端末からログアウトする（#208）。
 *
 * ## なぜこの画面に置くのか
 *
 * アカウント画面のセッション一覧は dashboard-worker にあり、**auth-worker の
 * CSRF トークンを持てない**。失効の経路は 3 つあるが、
 *
 * | 経路 | 対象 | form から使えるか |
 * | --- | --- | --- |
 * | `DELETE /account/api/me/sessions/:id` | 指定したセッション | **いいえ**（form は GET/POST のみ） |
 * | `POST /api/auth/logout?all=true` | 全端末 | **いいえ**（204 を返す JSON API） |
 * | `POST /login/logout` | この端末だけ（固定だった） | はい |
 *
 * **「全端末」と「form から使える」が両立する経路が無かった。** JS が
 * 動かない環境では「身に覚えのない端末がある」と気づいても何もできない。
 *
 * ## 個別のセッション指定は足さない
 *
 * `DELETE .../sessions/:id` と二重になり、§14.1 決定 16 で避けたものが戻る。
 * 「全部切る」は粒度が違うので別物として扱う。
 */
describe("すべての端末からログアウトする（JS 無し）", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedRegisteredUser();
  });

  /** その Cookie がまだ通るか。 */
  async function stillValid(cookie: string): Promise<boolean> {
    const response = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } });
    return response.status === 200;
  }

  it("all=true なら他の端末のセッションも切れる", async () => {
    const other = await login();
    const here = await login();
    // 前提: 2 つとも生きている。ここが崩れていると、あとの expect が
    // 「元から切れていた」を見ているだけになる。
    expect(await stillValid(other), "もう 1 台のセッションが作れていない").toBe(true);

    const page = await openLoginPage(here);
    const response = await submit(
      "/login/logout",
      { csrf_token: page.csrf, all: "true" },
      { cookie: page.cookie },
    );

    expect(response.status).toBe(303);
    expect(await stillValid(other), "他の端末が切れていない").toBe(false);
  });

  it("all が無ければ他の端末は生きたまま", async () => {
    // **既定を変えていないことの確認。** ボタンを押していない利用者の
    // セッションまで切れると、「別のアカウントでログインし直す」が
    // 全端末ログアウトになる。
    const other = await login();
    const here = await login();

    const page = await openLoginPage(here);
    await submit("/login/logout", { csrf_token: page.csrf }, { cookie: page.cookie });

    expect(await stillValid(other)).toBe(true);
  });

  it("all が true 以外なら他の端末は生きたまま", async () => {
    // `field()` は未指定で空文字を返す。「真っぽい値」を広く受けると、
    // **押していないほうが起きうる。**
    const other = await login();
    const here = await login();

    const page = await openLoginPage(here);
    await submit("/login/logout", { csrf_token: page.csrf, all: "1" }, { cookie: page.cookie });

    expect(await stillValid(other)).toBe(true);
  });

  it("CSRF トークンが無ければ全端末ログアウトも受け付けない", async () => {
    // **クロスサイトから `all=true` を送れると、他人のセッションを
    // 全部切れる**（被害者のブラウザが Cookie を付けて送るため）。
    const other = await login();
    const here = await login();

    const page = await openLoginPage(here);
    const response = await submit("/login/logout", { all: "true" }, { cookie: page.cookie });

    expect(response.status).toBe(403);
    expect(await stillValid(other), "拒否したのに切れている").toBe(true);
  });

  it("ログイン済み画面にボタンがある", async () => {
    // 経路が動いていても、押す手段が描かれていなければ届かない。
    const cookie = await login();
    const html = await (await SELF.fetch(`${BASE}/login`, { headers: { Cookie: cookie } })).text();

    expect(html).toContain('name="all"');
    expect(html).toContain("すべての端末からログアウト");
    // 同じ form に置く（CSRF トークンと戻り先を 2 組持たない）。
    expect(html.match(/action="\/login\/logout"/g) ?? []).toHaveLength(1);
  });

  it("終わったことを伝える", async () => {
    // **他の端末の話なので、この画面には何も変化が現れない。** 知らせが
    // 無いと、JS 無しの利用者は効いたか分からず何度も押す。
    const cookie = await login();
    const page = await openLoginPage(cookie);
    const response = await submit(
      "/login/logout",
      { csrf_token: page.csrf, all: "true" },
      { cookie: page.cookie },
    );

    const location = response.headers.get("Location") ?? "";
    expect(location).toBe("/login?logout=all");

    const html = await (await SELF.fetch(`${BASE}${location}`)).text();
    expect(html).toContain("すべての端末からログアウトしました");
  });

  it("クエリの文字列をそのまま画面へ出さない", async () => {
    // **固定値だけを見て、文言はサーバー側の定数。** ここをクエリの
    // 文字列を出す形にすると、攻撃者が選んだ文を本物のログイン画面に
    // 表示させられる（偽の案内を読ませる経路）。
    const html = await (
      await SELF.fetch(`${BASE}/login?logout=${encodeURIComponent("パスワードを入力してください")}`)
    ).text();

    expect(html).not.toContain("パスワードを入力してください");
    expect(html).not.toContain("ログアウトしました");
  });
});

describe("アカウントの存在を漏らさない", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedRegisteredUser();
  });

  /** CSRF トークンだけが毎回変わるので、比較の前に伏せる。 */
  function normalize(html: string): string {
    return html.replace(/name="csrf_token" value="[^"]+"/g, 'name="csrf_token" value="TOKEN"');
  }

  async function start(email: string): Promise<{ status: number; html: string }> {
    const session = await openLoginPage();
    const response = await submit(
      "/login/start",
      { csrf_token: session.csrf, email },
      { cookie: session.cookie },
    );
    return { status: response.status, html: normalize(await response.text()) };
  }

  it("登録済みと未登録で、コード送信の応答が完全に一致する", async () => {
    const registered = await start(REGISTERED);
    const unknown = await start(UNREGISTERED);

    expect(registered.status).toBe(200);
    expect(unknown.status).toBe(registered.status);
    // 画面に残るのは入力されたアドレスだけ。それ以外の差を作らない。
    expect(unknown.html.replaceAll(UNREGISTERED, "EMAIL")).toBe(
      registered.html.replaceAll(REGISTERED, "EMAIL"),
    );
  });

  it("送信画面に「登録されていません」の類を出さない", async () => {
    const { html } = await start(UNREGISTERED);
    for (const forbidden of ["登録されていません", "見つかりません", "存在しません"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  async function verify(email: string, code: string): Promise<{ status: number; html: string }> {
    const session = await openLoginPage();
    const response = await submit(
      "/login/verify",
      { csrf_token: session.csrf, email, code },
      { cookie: session.cookie },
    );
    return { status: response.status, html: normalize(await response.text()) };
  }

  it("チャレンジがある場合と無い場合で、誤ったコードの応答が一致する", async () => {
    await seedOtpChallenge(REGISTERED, "123456");

    const withChallenge = await verify(REGISTERED, "000000");
    const withoutChallenge = await verify(UNREGISTERED, "000000");

    expect(withChallenge.status).toBe(400);
    expect(withoutChallenge.status).toBe(withChallenge.status);
    expect(withoutChallenge.html.replaceAll(UNREGISTERED, "EMAIL")).toBe(
      withChallenge.html.replaceAll(REGISTERED, "EMAIL"),
    );
  });

  it("試行上限に達しても応答を変えない（429 にしない）", async () => {
    await seedOtpChallenge(REGISTERED, "123456");

    // 上限（OtpPolicy.maxAttempts = 5）を使い切る。
    for (let i = 0; i < 5; i += 1) await verify(REGISTERED, "000000");

    const exhausted = await verify(REGISTERED, "000000");
    const unknown = await verify(UNREGISTERED, "000000");

    // 上限だけ 429 にすると「そのアドレス宛にコードを出した」と分かる。
    expect(exhausted.status).toBe(400);
    expect(exhausted.status).toBe(unknown.status);
    expect(exhausted.html.replaceAll(REGISTERED, "EMAIL")).toBe(
      unknown.html.replaceAll(UNREGISTERED, "EMAIL"),
    );
  });

  it("形式の違うコードも、誤ったコードと同じ応答にする", async () => {
    await seedOtpChallenge(REGISTERED, "123456");

    const malformed = await verify(REGISTERED, "abc");
    const wrong = await verify(REGISTERED, "000000");

    expect(malformed.status).toBe(wrong.status);
    expect(malformed.html).toBe(wrong.html);
  });

  it("メールアドレスの形式不正だけは指摘してよい", async () => {
    // 送信先として成立していないという話で、アカウントの有無とは無関係。
    const { status, html } = await start("not-an-email");
    expect(status).toBe(400);
    expect(html).toContain("メールアドレスの形式");
  });
});
