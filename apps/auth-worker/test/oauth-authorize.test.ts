import { oauthAuthorizationCodes, oauthGrants } from "@u18/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./helpers";
import {
  authorize,
  authorizeQuery,
  consent,
  createPkcePair,
  db,
  locationParams,
  PUBLIC_CLIENT_ID,
  REDIRECT_URI,
  seedClient,
  seedDefaultClients,
  seedLoggedInUser,
  sessionCookie,
  type PkcePair,
  type SeededClient,
  type SeededUser,
} from "./helpers.oauth";

/**
 * `GET /oauth/authorize` と同意画面（#15 / 仕様書 5.1・9）。
 *
 * ここでしか確かめられないのは「リダイレクトしてよい場面とそうでない場面の
 * 切り分け」である。`client_id` や `redirect_uri` が不正なときにリダイレクト
 * すると、u18 が任意の宛先へのリダイレクタになる（RFC 6749 §4.1.2.1）。
 * UseCase の単体テストでは「どちらの種類を返したか」までしか見られないので、
 * 実際に `Location` が付かないことを HTTP 越しに固定する。
 */

let firstParty: SeededClient;
let thirdParty: SeededClient;
let user: SeededUser;
let pkce: PkcePair;

beforeEach(async () => {
  await resetDatabase();
  ({ firstParty, thirdParty } = await seedDefaultClients());
  user = await seedLoggedInUser();
  pkce = await createPkcePair();
});

describe("リダイレクトしてはならない失敗（RFC 6749 §4.1.2.1）", () => {
  it("未登録の client_id ではエラー画面を返し、Location を付けない", async () => {
    const response = await authorize(
      authorizeQuery({ client_id: "nope", code_challenge: pkce.challenge }),
      { cookie: sessionCookie(user) },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Content-Type")).toMatch(/text\/html/);
  });

  it("失効したクライアントでもエラー画面を返す", async () => {
    await seedClient({
      clientId: "disabled-client",
      clientType: "public",
      isFirstParty: false,
      disabledAt: new Date(),
    });

    const response = await authorize(
      authorizeQuery({ client_id: "disabled-client", code_challenge: pkce.challenge }),
      { cookie: sessionCookie(user) },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("登録と 1 文字違う redirect_uri でもエラー画面を返す", async () => {
    // 完全一致以外を作らない（domain/services/redirect-uri.ts）。
    const response = await authorize(
      authorizeQuery({
        redirect_uri: `${REDIRECT_URI}/`,
        code_challenge: pkce.challenge,
      }),
      { cookie: sessionCookie(user) },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("攻撃者の宛先を指定してもそこへは飛ばない", async () => {
    const response = await authorize(
      authorizeQuery({
        redirect_uri: "https://evil.test/steal",
        code_challenge: pkce.challenge,
      }),
      { cookie: sessionCookie(user) },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    // 入力された URL を本文へ出さない（反射型のコンテンツ注入を作らない）。
    expect(await response.text()).not.toContain("evil.test");
  });

  it("redirect_uri が無いときもエラー画面（登録が 1 本でも補完しない）", async () => {
    const response = await authorize(
      authorizeQuery({ redirect_uri: undefined, code_challenge: pkce.challenge }),
      { cookie: sessionCookie(user) },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });
});

describe("宛先が確定した後の失敗は redirect_uri へ返す", () => {
  const rejectedAt = async (overrides: Record<string, string | undefined>) => {
    const response = await authorize(authorizeQuery(overrides), { cookie: sessionCookie(user) });
    expect(response.status).toBe(303);

    const location = response.headers.get("Location") ?? "";
    expect(location.startsWith(REDIRECT_URI)).toBe(true);
    return locationParams(response);
  };

  it("response_type=token を拒否する（Implicit は提供しない）", async () => {
    const params = await rejectedAt({ response_type: "token", code_challenge: pkce.challenge });
    expect(params.get("error")).toBe("unsupported_response_type");
    expect(params.get("state")).toBe("state-123");
  });

  it("code_challenge が無いと拒否する", async () => {
    const params = await rejectedAt({ code_challenge: undefined });
    expect(params.get("error")).toBe("invalid_request");
  });

  it("code_challenge_method=plain を拒否する", async () => {
    // plain は認可要求を観測できる相手がそのまま code_verifier を得る。
    const params = await rejectedAt({
      code_challenge: pkce.verifier,
      code_challenge_method: "plain",
    });
    expect(params.get("error")).toBe("invalid_request");
  });

  it("code_challenge_method の省略を S256 として補わない", async () => {
    const params = await rejectedAt({
      code_challenge: pkce.challenge,
      code_challenge_method: undefined,
    });
    expect(params.get("error")).toBe("invalid_request");
  });

  it("openid 無しの scope を拒否する", async () => {
    const params = await rejectedAt({ scope: "profile", code_challenge: pkce.challenge });
    expect(params.get("error")).toBe("invalid_scope");
  });

  it("サポート外の scope を拒否する（黙って無視しない）", async () => {
    const params = await rejectedAt({
      scope: "openid admin",
      code_challenge: pkce.challenge,
    });
    expect(params.get("error")).toBe("invalid_scope");
  });

  it("クライアントに許可されていない scope を拒否する", async () => {
    await seedClient({
      clientId: "narrow-client",
      clientType: "public",
      isFirstParty: true,
      allowedScopes: "openid",
    });

    const params = await rejectedAt({
      client_id: "narrow-client",
      scope: "openid email",
      code_challenge: pkce.challenge,
    });
    expect(params.get("error")).toBe("invalid_scope");
  });

  it("Request Object は黙って無視せず拒否する", async () => {
    const params = await rejectedAt({ request: "ey.J.x", code_challenge: pkce.challenge });
    expect(params.get("error")).toBe("request_not_supported");
  });

  it("未知の prompt を拒否する", async () => {
    const params = await rejectedAt({ prompt: "whatever", code_challenge: pkce.challenge });
    expect(params.get("error")).toBe("invalid_request");
  });

  it("prompt=none と他の値の併用を拒否する", async () => {
    const params = await rejectedAt({ prompt: "none login", code_challenge: pkce.challenge });
    expect(params.get("error")).toBe("invalid_request");
  });

  it("max_age が整数でないと拒否する", async () => {
    const params = await rejectedAt({ max_age: "-1", code_challenge: pkce.challenge });
    expect(params.get("error")).toBe("invalid_request");
  });
});

describe("正常系（ファーストパーティは同意を省略する）", () => {
  it("redirect_uri?code=...&state=... へ 303 する", async () => {
    const response = await authorize(authorizeQuery({ code_challenge: pkce.challenge }), {
      cookie: sessionCookie(user),
    });

    expect(response.status).toBe(303);
    const params = locationParams(response);
    expect(params.get("code")).toBeTruthy();
    expect(params.get("state")).toBe("state-123");
    expect(params.get("error")).toBeNull();
    // 1 回限りの資格情報を中間キャッシュに載せない。
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("state をそのまま返す（記号を含んでいても壊さない）", async () => {
    const state = 'a&b=c#d "e"';
    const response = await authorize(authorizeQuery({ state, code_challenge: pkce.challenge }), {
      cookie: sessionCookie(user),
    });

    // URLSearchParams を通しているので、& や # で他のパラメータを偽装できない。
    expect(locationParams(response).get("state")).toBe(state);
    expect(locationParams(response).get("code")).toBeTruthy();
  });

  it("発行したコードの平文が DB に残らない", async () => {
    const response = await authorize(authorizeQuery({ code_challenge: pkce.challenge }), {
      cookie: sessionCookie(user),
    });
    const code = locationParams(response).get("code") ?? "";

    const rows = await db().select().from(oauthAuthorizationCodes).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.codeHash).not.toBe(code);
    // 保存されているのは SHA-256 の 16 進表現。
    expect(rows[0]?.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("有効期限が 60 秒で、session_id と auth_time が入る", async () => {
    await authorize(authorizeQuery({ code_challenge: pkce.challenge, nonce: "n-1" }), {
      cookie: sessionCookie(user),
    });

    const row = await db().select().from(oauthAuthorizationCodes).get();
    expect(row).toBeDefined();
    // `expires_at` は Clock から、`created_at` は Drizzle の $defaultFn から
    // 取るので、挿入までの数ミリ秒だけずれる。見たいのは「60 秒である」こと
    // なので、そのずれを許す幅で比べる（仕様書 5.3）。
    const lifetimeMs = row!.expiresAt.getTime() - row!.createdAt.getTime();
    expect(lifetimeMs).toBeLessThanOrEqual(60_000);
    expect(lifetimeMs).toBeGreaterThan(59_000);
    // ログアウト時に未交換コードを連鎖失効させるために持たせている（#15）。
    expect(row!.sessionId).toBe(user.sessionId);
    expect(row!.authTime.getTime()).toBe(user.authTime.getTime());
    expect(row!.nonce).toBe("n-1");
  });

  it("同意画面を省略しても同意の記録は残す", async () => {
    // 記録が無いと利用者が許可済みアプリを一覧・取り消しできず、
    // そもそも oauth_tokens.grant_id が NOT NULL なので表現もできない。
    await authorize(authorizeQuery({ code_challenge: pkce.challenge }), {
      cookie: sessionCookie(user),
    });

    const grant = await db()
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.clientId, firstParty.id))
      .get();
    expect(grant?.grantedScopes).toBe("openid profile email");
    expect(grant?.revokedAt).toBeNull();
  });
});

describe("未ログイン", () => {
  it("/login へ戻り先つきで誘導する", async () => {
    const response = await authorize(authorizeQuery({ code_challenge: pkce.challenge }));

    expect(response.status).toBe(303);
    const location = response.headers.get("Location") ?? "";
    expect(location.startsWith("/login?return_to=")).toBe(true);

    const returnTo = new URL(location, "http://localhost").searchParams.get("return_to");
    expect(returnTo?.startsWith("/oauth/authorize?")).toBe(true);
  });

  it("prompt=none なら画面を出さず login_required をクライアントへ返す", async () => {
    const response = await authorize(
      authorizeQuery({ prompt: "none", code_challenge: pkce.challenge }),
    );

    expect(response.status).toBe(303);
    expect(locationParams(response).get("error")).toBe("login_required");
  });

  it("期限切れのセッションは未ログインとして扱う", async () => {
    const stale = await seedLoggedInUser({
      authTime: new Date(Date.now() - 13 * 60 * 60 * 1000),
    });

    const response = await authorize(authorizeQuery({ code_challenge: pkce.challenge }), {
      cookie: sessionCookie(stale),
    });

    expect((response.headers.get("Location") ?? "").startsWith("/login")).toBe(true);
  });

  it("max_age を過ぎたセッションはログインし直させる", async () => {
    const response = await authorize(
      authorizeQuery({ max_age: "60", code_challenge: pkce.challenge }),
      {
        cookie: sessionCookie(
          await seedLoggedInUser({ authTime: new Date(Date.now() - 5 * 60 * 1000) }),
        ),
      },
    );

    expect((response.headers.get("Location") ?? "").startsWith("/login")).toBe(true);
  });

  it("prompt=login はセッションがあってもログイン画面へ送る", async () => {
    const response = await authorize(
      authorizeQuery({ prompt: "login", code_challenge: pkce.challenge }),
      { cookie: sessionCookie(user) },
    );

    expect((response.headers.get("Location") ?? "").startsWith("/login")).toBe(true);
  });
});

describe("同意画面（third-party）", () => {
  const thirdPartyQuery = (overrides: Record<string, string | undefined> = {}) =>
    authorizeQuery({
      client_id: PUBLIC_CLIENT_ID,
      code_challenge: pkce.challenge,
      ...overrides,
    });

  it("third-party では同意画面を出す（リダイレクトしない）", async () => {
    const response = await authorize(thirdPartyQuery(), { cookie: sessionCookie(user) });

    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();

    const html = await response.text();
    expect(html).toContain("へのアクセスを許可しますか？");
    // 誰として許可するのかを必ず出す。
    expect(html).toContain(user.displayName);
    // JS 無しで成立する（インライン script も外部 script も無い）。
    expect(html).not.toContain("<script");
  });

  it("prompt=none なら同意画面を出さず consent_required を返す", async () => {
    const response = await authorize(thirdPartyQuery({ prompt: "none" }), {
      cookie: sessionCookie(user),
    });

    expect(response.status).toBe(303);
    expect(locationParams(response).get("error")).toBe("consent_required");
  });

  it("CSRF トークンが無い同意は受け付けない", async () => {
    const response = await consent(
      {
        decision: "allow",
        client_id: PUBLIC_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "openid",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      },
      { cookie: sessionCookie(user) },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("同意するとコードが発行され、2 回目からは画面を出さない", async () => {
    const page = await authorize(thirdPartyQuery(), { cookie: sessionCookie(user) });
    const csrf = csrfFrom(page);

    const approved = await consent(
      {
        csrf_token: csrf.token,
        decision: "allow",
        client_id: PUBLIC_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "openid profile email",
        state: "state-123",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      },
      { cookie: `${sessionCookie(user)}; ${csrf.cookie}` },
    );

    expect(approved.status).toBe(303);
    expect(locationParams(approved).get("code")).toBeTruthy();
    expect(locationParams(approved).get("state")).toBe("state-123");

    // 同じ scope の再要求では同意画面を飛ばす（部分集合なら省略してよい）。
    const again = await authorize(thirdPartyQuery(), { cookie: sessionCookie(user) });
    expect(again.status).toBe(303);
    expect(locationParams(again).get("code")).toBeTruthy();
  });

  it("要求 scope が同意の部分集合でなければ再度同意を取る", async () => {
    await db()
      .insert(oauthGrants)
      .values({
        id: "grt_partial",
        userId: user.userId,
        clientId: thirdParty.id,
        grantedScopes: "openid",
        grantedAt: new Date(),
      })
      .run();

    const response = await authorize(thirdPartyQuery({ scope: "openid email" }), {
      cookie: sessionCookie(user),
    });
    expect(response.status).toBe(200);
  });

  it("取り消し済みの同意は根拠にならない", async () => {
    await db()
      .insert(oauthGrants)
      .values({
        id: "grt_revoked",
        userId: user.userId,
        clientId: thirdParty.id,
        grantedScopes: "openid profile email",
        grantedAt: new Date(Date.now() - 1000),
        revokedAt: new Date(),
      })
      .run();

    const response = await authorize(thirdPartyQuery(), { cookie: sessionCookie(user) });
    expect(response.status).toBe(200);
  });

  it("許可しないと access_denied をクライアントへ返す", async () => {
    const page = await authorize(thirdPartyQuery(), { cookie: sessionCookie(user) });
    const csrf = csrfFrom(page);

    const denied = await consent(
      {
        csrf_token: csrf.token,
        decision: "deny",
        client_id: PUBLIC_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "openid",
        state: "state-123",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      },
      { cookie: `${sessionCookie(user)}; ${csrf.cookie}` },
    );

    expect(denied.status).toBe(303);
    expect(locationParams(denied).get("error")).toBe("access_denied");
    expect(locationParams(denied).get("state")).toBe("state-123");
    expect(locationParams(denied).get("code")).toBeNull();
  });

  it("hidden field を改竄しても検証をすり抜けない", async () => {
    const page = await authorize(thirdPartyQuery(), { cookie: sessionCookie(user) });
    const csrf = csrfFrom(page);

    // POST でも GET とまったく同じ検証を通すので、未登録の宛先はここで落ちる。
    const tampered = await consent(
      {
        csrf_token: csrf.token,
        decision: "allow",
        client_id: PUBLIC_CLIENT_ID,
        redirect_uri: "https://evil.test/steal",
        response_type: "code",
        scope: "openid",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      },
      { cookie: `${sessionCookie(user)}; ${csrf.cookie}` },
    );

    expect(tampered.status).toBe(400);
    expect(tampered.headers.get("Location")).toBeNull();
  });
});

describe("CSP（ログイン画面と同じ定義を共有する）", () => {
  it("同意画面にも frame-ancestors 'none' が付く", async () => {
    const response = await authorize(
      authorizeQuery({ client_id: PUBLIC_CLIENT_ID, code_challenge: pkce.challenge }),
      { cookie: sessionCookie(user) },
    );

    const csp = response.headers.get("Content-Security-Policy") ?? "";
    // clickjacking で「許可」を押させる攻撃を塞ぐ。
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("unsafe-inline");
  });
});

/** 同意画面の HTML から CSRF トークンと Cookie を取り出す。 */
function csrfFrom(response: Response & { __html?: string }): {
  token: string;
  cookie: string;
} {
  const setCookie = response.headers.getSetCookie().find((raw) => raw.startsWith("u18_csrf="));
  if (setCookie === undefined) throw new Error("CSRF Cookie が無い");
  const cookie = setCookie.split(";")[0] ?? "";
  return { token: cookie.slice("u18_csrf=".length), cookie };
}
