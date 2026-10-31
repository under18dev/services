import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import type { Clock } from "../src/composition/container";
import { createFakeIdp } from "./fake-idp";
import { ORIGIN, cookieHeaderFrom, executionContext, fakeApprovals, loginAs } from "./helpers";

function fixedClock(ms: number): Clock {
  return { now: () => new Date(ms) };
}

describe("/health", () => {
  it("依存に触れずに 200 を返す", async () => {
    const app = createApp();
    const response = await app.fetch(new Request(`${ORIGIN}/health`), env, executionContext());
    expect(response.status).toBe(200);
  });
});

describe("/", () => {
  it("セッションが無ければ /login へ送る（return_to 付き）", async () => {
    const app = createApp();
    const response = await app.fetch(
      new Request(`${ORIGIN}/some/deep/path?x=1`),
      env,
      executionContext(),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/login?return_to=");
    expect(decodeURIComponent(location)).toContain("/some/deep/path?x=1");
  });
});

describe("/login", () => {
  it("PKCE つきの認可 URL へ 302 し、login-state Cookie を立てる", async () => {
    const idp = await createFakeIdp(env.AUTH_ISSUER);
    const app = createApp({ fetcher: idp.fetcherReturning("unused") });

    const response = await app.fetch(
      new Request(`${ORIGIN}/login?return_to=/account`),
      env,
      executionContext(),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(idp.discoveryDoc.authorization_endpoint);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe(env.OIDC_CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${env.ADMIN_ORIGIN}/callback`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    // **`admin` scope を要求しない。** u18 Identity 側には何も足さない
    // という運用者の判断（2026-10-30 夜）——admin-worker はただの
    // OIDC クライアントの 1 つで、「誰か」が分かれば十分である。
    expect(location.searchParams.get("scope")).toBe("openid");
    // **決定 8（#390）。** 要求するだけでは強制にならない——拒むのは
    // `/callback` の仕事（下の別 describe）。
    expect(location.searchParams.get("acr_values")).toBe("passkey");

    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.includes("u18_admin_login_state="))).toBe(true);
  });

  it("戻り先が無ければ既定（/）になる", async () => {
    const idp = await createFakeIdp(env.AUTH_ISSUER);
    const app = createApp({ fetcher: idp.fetcherReturning("unused") });

    const response = await app.fetch(new Request(`${ORIGIN}/login`), env, executionContext());
    expect(response.status).toBe(302);
    // login-state Cookie の中身は実装詳細なので直接は見ない。往復テストで確かめる。
  });
});

describe("/callback — 全体の往復", () => {
  it("ログイン開始から / で sub が見えるところまで通る", async () => {
    const idp = await createFakeIdp(env.AUTH_ISSUER);
    const clock = fixedClock(Date.UTC(2026, 9, 30));
    const approvals = fakeApprovals(["usr_admin_1"]);
    const app = createApp({ fetcher: idp.fetcherReturning("will-be-replaced"), clock, approvals });

    // ① /login
    const loginResponse = await app.fetch(
      new Request(`${ORIGIN}/login?return_to=/account/users`),
      env,
      executionContext(),
    );
    const authorizeUrl = new URL(loginResponse.headers.get("Location") ?? "");
    const state = authorizeUrl.searchParams.get("state")!;
    const nonce = authorizeUrl.searchParams.get("nonce")!;
    const loginStateCookie = cookieHeaderFrom(loginResponse);

    // ② 偽 IdP が、この nonce に対応する ID Token を発行する想定で作り直す。
    // `acr: "passkey"` が無いと決定 8 の確認（下の別 describe）で弾かれる。
    const idToken = await idp.signIdToken({
      sub: "usr_admin_1",
      aud: env.OIDC_CLIENT_ID,
      nonce,
      acr: "passkey",
    });
    const appWithRealToken = createApp({
      fetcher: idp.fetcherReturning(idToken),
      clock,
      approvals,
    });

    // ③ /callback
    const callbackResponse = await appWithRealToken.fetch(
      new Request(`${ORIGIN}/callback?code=auth-code-1&state=${state}`, {
        headers: { Cookie: loginStateCookie },
      }),
      env,
      executionContext(),
    );

    expect(callbackResponse.status).toBe(303);
    expect(callbackResponse.headers.get("Location")).toBe("/account/users");
    const sessionCookie = cookieHeaderFrom(callbackResponse);
    expect(sessionCookie).toContain("u18_admin_session=");
    // login-state Cookie は使い捨てなので、片付ける Set-Cookie も出ている。
    expect(
      callbackResponse.headers.getSetCookie().some((c) => c.startsWith("u18_admin_login_state=;")),
    ).toBe(true);

    // ④ セッション Cookie を持って / を開くと、sub が見える。
    const homeResponse = await appWithRealToken.fetch(
      new Request(`${ORIGIN}/`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    expect(homeResponse.status).toBe(200);
    expect(await homeResponse.text()).toContain("usr_admin_1");
  });

  it("state が一致しなければ 400 で、セッションは作られない。Kiwa の外枠でログインへ戻る導線を持つ（#443）", async () => {
    const idp = await createFakeIdp(env.AUTH_ISSUER);
    const app = createApp({ fetcher: idp.fetcherReturning("unused") });

    const loginResponse = await app.fetch(new Request(`${ORIGIN}/login`), env, executionContext());
    const loginStateCookie = cookieHeaderFrom(loginResponse);

    const response = await app.fetch(
      new Request(`${ORIGIN}/callback?code=c1&state=wrong-state`, {
        headers: { Cookie: loginStateCookie },
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie().some((c) => c.includes("u18_admin_session="))).toBe(
      false,
    );
    const html = await response.text();
    expect(html).toMatch(/<link rel="stylesheet"/);
    expect(html).toContain('href="/login"');
    // **内部の理由（state_mismatch 等）は画面に出さない。** `fail()` の方針。
    expect(html).not.toContain("state_mismatch");
  });

  it("login-state Cookie が無ければ 400（CSRF/リプレイ対策）", async () => {
    const idp = await createFakeIdp(env.AUTH_ISSUER);
    const app = createApp({ fetcher: idp.fetcherReturning("unused") });

    const response = await app.fetch(
      new Request(`${ORIGIN}/callback?code=c1&state=anything`),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
  });

  it("IdP が error を返したら 400 にする", async () => {
    const idp = await createFakeIdp(env.AUTH_ISSUER);
    const app = createApp({ fetcher: idp.fetcherReturning("unused") });

    const loginResponse = await app.fetch(new Request(`${ORIGIN}/login`), env, executionContext());
    const loginStateCookie = cookieHeaderFrom(loginResponse);

    const response = await app.fetch(
      new Request(`${ORIGIN}/callback?error=access_denied`, {
        headers: { Cookie: loginStateCookie },
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
  });

  it("ID Token の audience が違えば 400（他クライアント宛てトークンの横流し対策）", async () => {
    const idp = await createFakeIdp(env.AUTH_ISSUER);
    const app = createApp({ fetcher: idp.fetcherReturning("unused") });

    const loginResponse = await app.fetch(new Request(`${ORIGIN}/login`), env, executionContext());
    const authorizeUrl = new URL(loginResponse.headers.get("Location") ?? "");
    const state = authorizeUrl.searchParams.get("state")!;
    const nonce = authorizeUrl.searchParams.get("nonce")!;
    const loginStateCookie = cookieHeaderFrom(loginResponse);

    const idToken = await idp.signIdToken({ sub: "usr_1", aud: "some-other-client", nonce });
    const appWithToken = createApp({ fetcher: idp.fetcherReturning(idToken) });

    const response = await appWithToken.fetch(
      new Request(`${ORIGIN}/callback?code=c1&state=${state}`, {
        headers: { Cookie: loginStateCookie },
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
  });
});

/**
 * 決定 8（管理者は Passkey のセッションでしか振る舞えない、#390）。
 *
 * **`IdentityAdminDelegatedRPC` には再認証も管理者判定も無い**
 * （`app.ts` の `REQUIRED_ACR` の JSDoc を参照）ので、ここで弾かないと
 * admin-worker 経由だけメール OTP でも利用者の停止や OAuth クライアント
 * の登録ができてしまう。
 */
describe("acr の確認（決定 8、#390）", () => {
  async function callbackWith(acr: string | undefined): Promise<Response> {
    const idp = await createFakeIdp(env.AUTH_ISSUER);
    const app = createApp({ fetcher: idp.fetcherReturning("unused") });

    const loginResponse = await app.fetch(new Request(`${ORIGIN}/login`), env, executionContext());
    const authorizeUrl = new URL(loginResponse.headers.get("Location") ?? "");
    const state = authorizeUrl.searchParams.get("state")!;
    const nonce = authorizeUrl.searchParams.get("nonce")!;
    const loginStateCookie = cookieHeaderFrom(loginResponse);

    const idToken = await idp.signIdToken({
      sub: "usr_otp",
      aud: env.OIDC_CLIENT_ID,
      nonce,
      ...(acr === undefined ? {} : { acr }),
    });
    const appWithToken = createApp({ fetcher: idp.fetcherReturning(idToken) });

    return appWithToken.fetch(
      new Request(`${ORIGIN}/callback?code=c1&state=${state}`, {
        headers: { Cookie: loginStateCookie },
      }),
      env,
      executionContext(),
    );
  }

  it("acr が無ければ（メール OTP 相当）403 で、セッションを作らない", async () => {
    const response = await callbackWith(undefined);

    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie().some((c) => c.includes("u18_admin_session="))).toBe(
      false,
    );
    // 攻撃ではなく本人の選択なので、やり直し方を具体的に伝える
    // （`fail()` の「画面に理由を出さない」方針とは別——`app.ts` を参照）。
    const html = await response.text();
    expect(html).toContain("パスキー");
    expect(html).toMatch(/<link rel="stylesheet"/);
    expect(html).toContain('href="/login"');
  });

  it("acr が u18 の定義する水準と違えば 403", async () => {
    // 将来 u18 以外の値が IdP から返る可能性（規格上は自由記述）に備える。
    const response = await callbackWith("mfa");

    expect(response.status).toBe(403);
  });

  it('acr が "passkey" なら通る', async () => {
    const response = await callbackWith("passkey");

    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie().some((c) => c.includes("u18_admin_session="))).toBe(
      true,
    );
  });
});

describe("/logout", () => {
  it("セッション Cookie を落として /login へ送る", async () => {
    const app = createApp();
    const response = await app.fetch(new Request(`${ORIGIN}/logout`), env, executionContext());

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
    expect(response.headers.getSetCookie().some((c) => c.startsWith("u18_admin_session=;"))).toBe(
      true,
    );
  });
});

describe("承認リスト", () => {
  it("承認されていなければ / から /pending へ送られる", async () => {
    const approvals = fakeApprovals([]); // 誰も承認されていない
    const sessionCookie = await loginAs("usr_waiting", approvals);

    const app = createApp({ approvals });
    const response = await app.fetch(
      new Request(`${ORIGIN}/`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/pending");
  });

  it("/pending は自分の sub と、承認する人へ渡す grant コマンドを表示する", async () => {
    // **最初の 1 人は、ここでしか自分の sub を知れない。** 承認リストが
    // 空の状態では `/` へ辿り着けず、CLI（admin-approval.mjs）に渡す
    // 値を他で見る手段が無い（運用者表を直接引くか、別の管理者になって
    // 入るかしか無く、どちらも筋が悪い）。以前はここを「実装の語は
    // 出さない」として sub を隠していたが、隠すべきは逆の側だった。
    const approvals = fakeApprovals([]);
    const sessionCookie = await loginAs("usr_waiting", approvals);

    const app = createApp({ approvals });
    const response = await app.fetch(
      new Request(`${ORIGIN}/pending`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("承認");
    expect(html).toContain("usr_waiting");
    expect(html).toContain("admin-approval.mjs grant");
    expect(html).toContain("--sub usr_waiting");
    expect(html).toContain("--super");
    // **コピーできるように `<textarea readonly>` にしてある**（#443）。
    // `<pre><code>` のままだとドラッグでしかコピーできない。
    expect(html).toMatch(/<textarea[^>]*readonly[^>]*>/);
    expect(html).toMatch(/<link rel="stylesheet"/);
  });

  it("承認済みが /pending を開くと / へ戻される（ループにしない）", async () => {
    const approvals = fakeApprovals(["usr_ok"]);
    const sessionCookie = await loginAs("usr_ok", approvals);

    const app = createApp({ approvals });
    const response = await app.fetch(
      new Request(`${ORIGIN}/pending`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
  });

  it("承認されていれば / が見える。Kiwa の外枠とナビを持つ（#443）", async () => {
    const approvals = fakeApprovals(["usr_ok"]);
    const sessionCookie = await loginAs("usr_ok", approvals);

    const app = createApp({ approvals });
    const response = await app.fetch(
      new Request(`${ORIGIN}/`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("usr_ok");
    expect(html).toMatch(/<link rel="stylesheet"/);
    // 4 枚すべてへの導線を持つ——プレースホルダ時代のリンク列挙を踏襲する。
    expect(html).toContain('href="/nfc"');
    expect(html).toContain('href="/clients"');
    expect(html).toContain('href="/users"');
    expect(html).toContain('href="/audit"');
  });

  it("未ログインで /pending を開くとログインへ送る", async () => {
    const app = createApp({ approvals: fakeApprovals([]) });
    const response = await app.fetch(new Request(`${ORIGIN}/pending`), env, executionContext());

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/login?return_to=");
  });

  it("本物の D1（ADMIN_DB）に対しても isApproved / isSuperApprover が動く", async () => {
    // ここだけ fake を使わず、本物の DrizzleApprovalRepository を通す。
    // マイグレーション（test/setup.ts）が適用済みの ADMIN_DB に対して。
    const { DrizzleApprovalRepository } =
      await import("../src/infrastructure/persistence/drizzle-approval.repository");
    const { createAdminDatabase, adminApprovals } = await import("@u18/admin-db");

    const db = createAdminDatabase(env.ADMIN_DB);
    await db
      .insert(adminApprovals)
      .values({ id: "adm_test1", sub: "usr_real", isSuperApprover: true, approvedBySub: null })
      .run();

    const repo = new DrizzleApprovalRepository(db);
    expect(await repo.isApproved("usr_real")).toBe(true);
    expect(await repo.isApproved("usr_not_in_list")).toBe(false);
    expect(await repo.isSuperApprover("usr_real")).toBe(true);
    expect(await repo.isSuperApprover("usr_not_in_list")).toBe(false);
  });
});
