import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RpcErrorCode, rpcErr, rpcOk } from "@u18/contracts";
import { createApp } from "../src/presentation/http/app";
import type { Clock } from "../src/composition/container";
import {
  GOOGLE_SANS_FONT_PATH,
  ISLAND_PATH,
  KIWA_STYLESHEET_PATH,
} from "../src/presentation/http/ui/asset-paths";
import { createFakeIdp } from "./fake-idp";
import {
  ORIGIN,
  cookieHeaderFrom,
  executionContext,
  fakeApprovals,
  loginAs,
  minimalIdentityAdmin,
  minimalNfcCards,
} from "./helpers";

function fixedClock(ms: number): Clock {
  return { now: () => new Date(ms) };
}

describe("/health", () => {
  it("依存に触れずに 200 を返す", async () => {
    const app = createApp();
    const response = await app.fetch(new Request(`${ORIGIN}/health`), env, executionContext());
    expect(response.status).toBe(200);
  });

  /**
   * #479。**`asset-paths.ts` の実際の値と突き合わせる** —— 固定文字列を
   * 書き写すと、ハッシュが変わったときにテストだけが古いまま緑で残る
   * （本番の `smoke-asset-probe.sh` がここを直接 curl するので、
   * 突き合わせの甘さがそのまま検査の甘さになる）。
   */
  it("配信中のアセットのパスを載せる", async () => {
    const app = createApp();
    const response = await app.fetch(new Request(`${ORIGIN}/health`), env, executionContext());
    const body = await response.json();
    expect(body).toMatchObject({
      assets: [KIWA_STYLESHEET_PATH, ISLAND_PATH, GOOGLE_SANS_FONT_PATH],
    });
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
      nfcCards: minimalNfcCards(),
      identityAdmin: minimalIdentityAdmin(),
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
    expect(html).toContain(`<link rel="stylesheet" href="${KIWA_STYLESHEET_PATH}"/>`);
    expect(html).toContain('href="/login"');
    // **内部の理由（state_mismatch 等）は画面に出さない。** `fail()` の方針。
    expect(html).not.toContain("state_mismatch");
    // **見出しと本文で同じ文を 2 回言わない（#517）。** 以前は
    // `title`/`message` が共に「ログインをやり直してください」で、
    // 句点の有無しか違わなかった——本文は次の一手だけを言う。
    expect(html).toContain("ログインをやり直してください");
    expect(html).toContain("下のボタンから、もう一度お試しください。");
    // 以前の本文（見出しと同じ文に句点だけ足したもの）が残っていないこと。
    expect(html).not.toContain("ログインをやり直してください。");
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
    expect(html).toContain(`<link rel="stylesheet" href="${KIWA_STYLESHEET_PATH}"/>`);
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

  it("super approver が 1 人も居なければ、grant コマンドに --super を付ける", async () => {
    // **最初の 1 人は、ここでしか自分の sub を知れない。** 承認リストが
    // 空の状態では `/` へ辿り着けず、CLI（admin-approval.mjs）に渡す
    // 値を他で見る手段が無い（運用者表を直接引くか、別の管理者になって
    // 入るかしか無く、どちらも筋が悪い）。以前はここを「実装の語は
    // 出さない」として sub を隠していたが、隠すべきは逆の側だった。
    //
    // **super approver が 0 人のときだけ `--super` を付ける（#517）。**
    // `/approvals` 自体が `APPROVAL_GRANT` を持つ人からしか開けないので、
    // super approver が 1 人も居ない間は、CLI 以外に先へ進む経路が無い。
    const approvals = fakeApprovals([]); // 誰も承認されていない＝super approver も 0 人
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
    // **コピーボタンで持ち出せる**（#488）。`data-copy` の値そのものに
    // sub とコマンド全体が乗っている——`<textarea readonly>` は #470 より
    // 前の、まだ島の仕組みが無かった頃の代替だった（削除済み）。
    expect(html).toContain('data-copy="usr_waiting"');
    expect(html).toContain('data-copy="node apps/admin-worker/scripts/admin-approval.mjs grant');
    expect(html).not.toMatch(/<textarea/);
    expect(html).toContain(`<link rel="stylesheet" href="${KIWA_STYLESHEET_PATH}"/>`);
    // **`/pending` は `NAV_PAGE_ROUTES` の外にある**ので、
    // `test/asset-coverage.test.ts` の「`data-*` を使う画面は
    // `ISLAND_PATH` も読む」という検査がここを見ない（#488 で発覚）。
    // ここで直接確かめる。
    expect(html).toContain(ISLAND_PATH);
  });

  it("super approver が既に居れば、grant コマンドから --super を外す（#517）", async () => {
    // **本番のバグだった側。** 以前はここが常に `--super` 付きで、
    // 2 人目以降の承認待ちの画面にもコピーボタン付きで出ていた
    // ——貼って実行すると、新しい承認が無条件に全操作できる
    // super approver になってしまう（`/approvals` の「新規の承認は
    // 権限 0（最小権限）から始まる」と食い違う）。
    const approvals = fakeApprovals(["usr_existing_admin"], ["usr_existing_admin"]);
    const sessionCookie = await loginAs("usr_waiting_2nd", approvals);

    const app = createApp({ approvals });
    const response = await app.fetch(
      new Request(`${ORIGIN}/pending`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("admin-approval.mjs grant");
    expect(html).toContain("--sub usr_waiting_2nd");
    expect(html).not.toContain("--super");
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

    const app = createApp({
      approvals,
      nfcCards: minimalNfcCards(),
      identityAdmin: minimalIdentityAdmin(),
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("usr_ok");
    expect(html).toContain(`<link rel="stylesheet" href="${KIWA_STYLESHEET_PATH}"/>`);
    // 4 枚すべてへの導線を持つ——プレースホルダ時代のリンク列挙を踏襲する。
    expect(html).toContain('href="/nfc"');
    expect(html).toContain('href="/clients"');
    expect(html).toContain('href="/users"');
    expect(html).toContain('href="/audit"');
  });

  it("/ は NFC・クライアントの集計と直近の監査ログをダッシュボードとして出す（#449）", async () => {
    const approvals = fakeApprovals(["usr_ok"]);
    const sessionCookie = await loginAs("usr_ok", approvals);

    const app = createApp({
      approvals,
      nfcCards: {
        ...minimalNfcCards(),
        countCards: async () => rpcOk({ issued: 3, active: 5, disabled: 1 }),
      },
      identityAdmin: {
        ...minimalIdentityAdmin(),
        countOAuthClients: async () => rpcOk(2),
        countUsers: async () => rpcOk({ active: 10, suspended: 4, deleted: 2 }),
        listAuditLogs: async () =>
          rpcOk({
            entries: [
              {
                id: "aud_1",
                event: "ops.user.suspended",
                userId: "usr_taro",
                actor: "admin-worker",
                outcome: "success",
                reason: "abuse",
                metadata: null,
                ipHash: null,
                userAgent: null,
                createdAt: "2026-10-31T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          }),
      },
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    // **一覧を全部引いて数えていない。** `countCards` / `countOAuthClients` /
    // `countUsers` が返した数字がそのまま出る。単独の数字（"3" 等）は CSS の
    // ハッシュや viewport のメタタグにも出るので、ラベルの直後に来ることまで見る。
    expect(html).toMatch(/未紐づけ[^<]*<span[^>]*>3<\/span>/);
    expect(html).toMatch(/有効[^<]*<span[^>]*>5<\/span>/);
    expect(html).toMatch(/無効化済み[^<]*<span[^>]*>1<\/span>/);
    expect(html).toMatch(/OAuth クライアント[\s\S]*?<span[^>]*>2<\/span>/);
    // **`/users` への導線を持ち、状態ごとに分けて出す**（#512）。
    expect(html).toContain('href="/users"');
    expect(html).toMatch(/有効[^<]*<span[^>]*>10<\/span>/);
    expect(html).toMatch(/停止中[^<]*<span[^>]*>4<\/span>/);
    expect(html).toMatch(/削除済み[^<]*<span[^>]*>2<\/span>/);
    expect(html).toContain("ops.user.suspended");
    expect(html).toContain("usr_taro");
    // **承認待ちの人数は出さない**（admin-worker に「承認待ち」の行が
    // 存在しないため。`home-page.tsx` の冒頭を参照）。
    expect(html).not.toContain("承認待ちの人数");
    // **見出しは出る範囲に合わせてある**（#515）。カードの操作はここに
    // 出ないので、`/nfc` への導線を添えている。「権限」は見出しに入れて
    // いない——`/approvals` の履歴を見る画面がどこにも無く、「別の場所で
    // 見られます」と書ける行き先が無いため（3b のレビュー指摘）。
    expect(html).toContain("利用者・アプリの操作");
    expect(html).not.toContain("直近の管理操作");
    expect(html).not.toContain("利用者・アプリ・権限の操作");
    expect(html).toMatch(/カードの操作は[\s\S]*?href="\/nfc"[\s\S]*?側で見られます/);
  });

  it("「直近の管理操作」はログインに流されないよう、運営の操作だけに絞って取得する（#515）", async () => {
    const approvals = fakeApprovals(["usr_ok"]);
    const sessionCookie = await loginAs("usr_ok", approvals);
    const listAuditLogsCalls: unknown[] = [];

    const app = createApp({
      approvals,
      nfcCards: minimalNfcCards(),
      identityAdmin: {
        ...minimalIdentityAdmin(),
        listAuditLogs: async (input) => {
          listAuditLogsCalls.push(input);
          return rpcOk({ entries: [], nextCursor: null });
        },
      },
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    // **`listUsers` のように全ページを舐めて JS 側で絞るのではなく、
    // auth-worker 側に「運営の操作だけ」を指定する。** 具体的な event 名は
    // admin-worker 側に書き写さない——`OPERATOR_ACTION_EVENTS` の冒頭を参照。
    expect(listAuditLogsCalls).toEqual([
      { actorUserId: "usr_ok", category: "operator_action", limit: 5 },
    ]);
  });

  it("直近の管理操作の利用者を名前で出す（#482）", async () => {
    const approvals = fakeApprovals(["usr_ok"]);
    const sessionCookie = await loginAs("usr_ok", approvals);

    const app = createApp({
      approvals,
      nfcCards: minimalNfcCards(),
      identityAdmin: {
        ...minimalIdentityAdmin(),
        listAuditLogs: async () =>
          rpcOk({
            entries: [
              {
                id: "aud_1",
                event: "ops.user.suspended",
                userId: "usr_taro",
                actor: "admin-worker",
                outcome: "success",
                reason: "abuse",
                metadata: null,
                ipHash: null,
                userAgent: null,
                createdAt: "2026-10-31T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          }),
        getUsersByIds: async () =>
          rpcOk([{ id: "usr_taro", username: "taro", displayName: "太郎", status: "active" }]),
      },
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("太郎 (@taro)");
    expect(html).toContain('href="/users/usr_taro"');
  });

  it("監査ログは取れたが名前解決が RPC の例外で落ちても、一覧は出る（#482）", async () => {
    // **「監査ログは取れたが名前解決が落ちた」を「監査ログごと取れなかった」
    // に畳まない**（3b のレビュー指摘）。`resolveUserRefs` は
    // `allSettled` の塊には混ぜず、監査ログが取れたあとに別で呼ぶ
    // （`app.tsx` の `/` ハンドラを参照）。
    const approvals = fakeApprovals(["usr_ok"]);
    const sessionCookie = await loginAs("usr_ok", approvals);

    const app = createApp({
      approvals,
      nfcCards: minimalNfcCards(),
      identityAdmin: {
        ...minimalIdentityAdmin(),
        listAuditLogs: async () =>
          rpcOk({
            entries: [
              {
                id: "aud_1",
                event: "ops.user.suspended",
                userId: "usr_taro",
                actor: "admin-worker",
                outcome: "success",
                reason: "abuse",
                metadata: null,
                ipHash: null,
                userAgent: null,
                createdAt: "2026-10-31T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          }),
        getUsersByIds: () => Promise.reject(new Error("binding unavailable")),
      },
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    // 監査ログの一覧自体は出ている——「いま取れません」ではない。
    expect(html).toContain("ops.user.suspended");
    expect(html).not.toContain("いま取れません");
  });

  it("一部の集計が失敗しても、他の塊とサインイン情報は出す（#449）", async () => {
    const approvals = fakeApprovals(["usr_ok"]);
    const sessionCookie = await loginAs("usr_ok", approvals);

    const app = createApp({
      approvals,
      nfcCards: {
        ...minimalNfcCards(),
        countCards: async () => rpcErr(RpcErrorCode.Internal, "boom"),
      },
      identityAdmin: {
        ...minimalIdentityAdmin(),
        countOAuthClients: async () => rpcOk(7),
      },
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    // **画面全体は潰れない。** `serviceUnavailable`（503）は使わない。
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("usr_ok");
    expect(html).toMatch(/OAuth クライアント[\s\S]*?<span[^>]*>7<\/span>/);
    expect(html).toContain("いま取れません");
  });

  it("塊の 1 つが reject しても、他の塊とサインイン情報は出す（#452）", async () => {
    // **上のテストとは違う失敗の形。** `rpcErr` は値として返るので
    // `Promise.all` でも問題にならない——ここで確かめたいのは
    // Service Binding 自体の失敗や例外（= reject）で、`Promise.all` の
    // ままだとこの 1 件でホーム全体が 500 になる。
    const approvals = fakeApprovals(["usr_ok"]);
    const sessionCookie = await loginAs("usr_ok", approvals);

    const app = createApp({
      approvals,
      nfcCards: {
        ...minimalNfcCards(),
        countCards: () => Promise.reject(new Error("binding unavailable")),
      },
      identityAdmin: {
        ...minimalIdentityAdmin(),
        countOAuthClients: async () => rpcOk(7),
      },
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("usr_ok");
    expect(html).toMatch(/OAuth クライアント[\s\S]*?<span[^>]*>7<\/span>/);
    expect(html).toContain("いま取れません");
  });

  it("利用者数の集計だけが落ちても、他の塊とサインイン情報は出す（#512）", async () => {
    const approvals = fakeApprovals(["usr_ok"]);
    const sessionCookie = await loginAs("usr_ok", approvals);

    const app = createApp({
      approvals,
      nfcCards: {
        ...minimalNfcCards(),
        countCards: async () => rpcOk({ issued: 1, active: 1, disabled: 1 }),
      },
      identityAdmin: {
        ...minimalIdentityAdmin(),
        countOAuthClients: async () => rpcOk(7),
        countUsers: () => Promise.reject(new Error("binding unavailable")),
      },
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("usr_ok");
    expect(html).toMatch(/OAuth クライアント[\s\S]*?<span[^>]*>7<\/span>/);
    expect(html).toContain("いま取れません");
    // **カードとクライアントは出ている。** 利用者の塊だけが
    // 「いま取れません」に落ちたことを、他の数字が出ていることで示す。
    expect(html).toMatch(/未紐づけ[^<]*<span[^>]*>1<\/span>/);
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
