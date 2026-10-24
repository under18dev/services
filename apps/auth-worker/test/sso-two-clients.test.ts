import { createExecutionContext } from "cloudflare:test";
import { oauthGrants, oauthTokens } from "@u18/db";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { IdentityRPC } from "../src/presentation/rpc/identity.entrypoint";
import { resetDatabase } from "./helpers";
import {
  appEnv,
  authorize,
  authorizeQuery,
  BASE,
  consent,
  createPkcePair,
  db,
  fetchApp,
  locationParams,
  ORIGIN,
  seedClient,
  seedLoggedInUser,
  seedSigningKey,
  sessionCookie,
  tokenRequest,
  userinfoRequest,
  type PkcePair,
  type SeededClient,
  type SeededUser,
  type SigningKey,
} from "./helpers.oauth";

/**
 * 独立した 2 クライアント間の SSO（#20 / 仕様書 11.3・12 Phase 2 完了条件・13）。
 *
 * Phase 2 の完了条件は「独立した 2 サービスから『Sign in with u18』により
 * 認証できる」である。エンドポイント単位のテスト（`oauth-authorize` /
 * `oauth-token` / `oauth-userinfo`）はいずれも **1 クライアント分の 1 周**しか
 * 見ていない。そこを何本足しても「2 つ目のサービスへ行ったときに再ログインを
 * 求められないか」「2 つのサービスが互いのトークンを使えないか」は分からない。
 * 確かめたいのは個々の応答ではなく、**1 本のセッションを 2 クライアントが
 * どう共有し、どこで分離されるか**という関係である。
 *
 * ## 対照群の置き方
 *
 * 「SSO が成立した」は単独では何も証明しない。セッションの有無に関わらず
 * コードが出る実装でも同じ緑になるからである。そこで SSO を主張する各テストに
 * 「セッションが無ければ同じ要求がログイン画面へ送られる」を必ず対にして置く
 * （`passkey-webauthn.test.ts` と同じ考え方）。分離・失効についても同様に、
 * 「効くはずの側」と「効いてはならない側」を 1 つのテストに同居させる。
 *
 * ## 2 つのクライアントは `client:seed-dev` と同じ形にしてある
 *
 * `client_id`・`redirect_uri`・秘密・first-party かどうかを
 * `scripts/oauth-client.mjs` の `DEV_CLIENTS` と一致させている（runbook §9.4）。
 * このテストが通る構成と、開発者が `wrangler dev` で手作業で踏む構成が
 * 同じものになるため。別々の値にすると、自動テストだけが通る形に
 * 寄っていっても誰も気付かない。
 *
 * 既定の `seedDefaultClients()` を使わないのも同じ理由で、あちらは 2 つの
 * クライアントが**同じ `redirect_uri`** を共有している。「独立した 2 サービス」
 * を名乗るには宛先が別ホストであることまで含めて再現する必要がある。
 */

/** クライアント A: ファーストパーティの confidential（u18 公式のダッシュボード想定）。 */
const DASHBOARD = {
  clientId: "u18-dashboard-local",
  secret: "dev-only-secret-dashboard",
  redirectUri: "http://localhost:8788/account/callback",
} as const;

/** クライアント B: サードパーティの public（外部サービス想定。PKCE のみで認証する）。 */
const PARTNER = {
  clientId: "u18-e2e-local",
  redirectUri: "http://localhost:8789/cb",
} as const;

const ISSUER = ORIGIN;
const SCOPE = "openid profile email";

let dashboard: SeededClient;
let partner: SeededClient;
let user: SeededUser;
let signingKey: SigningKey;

beforeEach(async () => {
  await resetDatabase();
  dashboard = await seedClient({
    clientId: DASHBOARD.clientId,
    clientType: "confidential",
    isFirstParty: true,
    secret: DASHBOARD.secret,
    redirectUris: [DASHBOARD.redirectUri],
  });
  partner = await seedClient({
    clientId: PARTNER.clientId,
    clientType: "public",
    isFirstParty: false,
    redirectUris: [PARTNER.redirectUri],
  });
  user = await seedLoggedInUser();
  signingKey = await seedSigningKey();
});

type ClientSpec = { readonly clientId: string; readonly redirectUri: string };

type TokenResponse = {
  access_token: string;
  id_token: string;
  scope: string;
};

/** 認可要求。`state` はクライアントごとに変えて、取り違えを検出できるようにする。 */
function queryFor(
  client: ClientSpec,
  pkce: PkcePair,
  overrides: Record<string, string | undefined> = {},
) {
  return authorizeQuery({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: SCOPE,
    state: `state-${client.clientId}`,
    code_challenge: pkce.challenge,
    ...overrides,
  });
}

function requestAuthorize(
  client: ClientSpec,
  pkce: PkcePair,
  options: { readonly cookie?: string } = {},
): Promise<Response> {
  // `exactOptionalPropertyTypes` が有効なので、Cookie 無し（未ログインの
  // 対照群）は **キーごと落とす**。`cookie: undefined` を渡すと型が合わない。
  const query = queryFor(client, pkce);
  return options.cookie === undefined
    ? authorize(query, { env: appEnv(signingKey) })
    : authorize(query, { cookie: options.cookie, env: appEnv(signingKey) });
}

/**
 * CSRF は Cookie 側だけ読む（double-submit なので hidden field と同値）。
 * `oauth-authorize.test.ts` の同名ヘルパーと同じ。
 */
function csrfFrom(response: Response): { token: string; cookie: string } {
  const setCookie = response.headers.getSetCookie().find((raw) => raw.startsWith("u18_csrf="));
  if (setCookie === undefined) throw new Error("CSRF Cookie が無い");
  const cookie = setCookie.split(";")[0] ?? "";
  return { token: cookie.slice("u18_csrf=".length), cookie };
}

/** 同意画面を「許可」で送る。third-party だけが通る経路。 */
function approve(page: Response, client: ClientSpec, pkce: PkcePair, cookie: string) {
  const csrf = csrfFrom(page);
  return consent(
    {
      csrf_token: csrf.token,
      decision: "allow",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      response_type: "code",
      scope: SCOPE,
      state: `state-${client.clientId}`,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    },
    { cookie: `${cookie}; ${csrf.cookie}`, env: appEnv(signingKey) },
  );
}

function codeFrom(response: Response): string {
  const code = locationParams(response).get("code");
  if (code === null) {
    throw new Error(
      `コードが得られなかった: ${response.status} ${response.headers.get("Location")}`,
    );
  }
  return code;
}

/** 認可コードをトークンへ交換する。confidential は秘密を、public は PKCE だけを出す。 */
async function exchange(
  client: ClientSpec,
  code: string,
  pkce: PkcePair,
  secret?: string,
): Promise<TokenResponse> {
  const response = await tokenRequest(
    {
      grant_type: "authorization_code",
      client_id: client.clientId,
      client_secret: secret,
      redirect_uri: client.redirectUri,
      code,
      code_verifier: pkce.verifier,
    },
    { env: appEnv(signingKey) },
  );
  expect(response.status, `${client.clientId} のトークン交換に失敗した`).toBe(200);
  return (await response.json()) as TokenResponse;
}

/** A（first-party）で 1 周する。同意画面は挟まらない。 */
async function signInToDashboard(cookie: string): Promise<TokenResponse> {
  const pkce = await createPkcePair();
  const authorized = await requestAuthorize(DASHBOARD, pkce, { cookie });
  return exchange(DASHBOARD, codeFrom(authorized), pkce, DASHBOARD.secret);
}

/** B（third-party）で 1 周する。同意画面を 1 度通る。 */
async function signInToPartner(cookie: string): Promise<TokenResponse> {
  const pkce = await createPkcePair();
  const page = await requestAuthorize(PARTNER, pkce, { cookie });
  const authorized = page.status === 200 ? await approve(page, PARTNER, pkce, cookie) : page;
  return exchange(PARTNER, codeFrom(authorized), pkce);
}

/**
 * ID Token を **RP と同じ手順で**検証する。
 *
 * 署名鍵のオブジェクトをテストから直接渡さず、`/.well-known/jwks.json` を
 * 実際に取得して鍵集合を組む（#20 の受け入れ条件）。テスト内の `publicJwk` を
 * 使うと、JWKS エンドポイントが間違った鍵を配っていても通ってしまう。
 */
async function verifyIdToken(idToken: string, audience: string): Promise<JWTPayload> {
  const response = await fetchApp(new Request(`${BASE}/.well-known/jwks.json`), appEnv(signingKey));
  expect(response.status, "JWKS を取得できなかった").toBe(200);
  const jwks = createLocalJWKSet((await response.json()) as JSONWebKeySet);

  const { payload } = await jwtVerify(idToken, jwks, { issuer: ISSUER, audience });
  return payload;
}

function logout(cookie: string): Promise<Response> {
  return fetchApp(
    new Request(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: ORIGIN },
    }),
    appEnv(signingKey),
  );
}

function revokeSession(cookie: string, sessionId: string): Promise<Response> {
  return fetchApp(
    new Request(`${BASE}/api/me/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: ORIGIN },
    }),
    appEnv(signingKey),
  );
}

/** 「ログイン画面へ送られた」かどうか。SSO の対照群はすべてこれで判定する。 */
function sentToLogin(response: Response): boolean {
  return (
    response.status === 303 &&
    (response.headers.get("Location") ?? "").startsWith("/login?return_to=")
  );
}

describe("1 つのセッションから独立した 2 クライアントへ（Phase 2 完了条件）", () => {
  it("A でログイン済みなら B は再ログインを要求されない", async () => {
    const cookie = sessionCookie(user);

    // A は first-party なので同意も挟まず、その場でコードが返る。
    const atDashboard = await requestAuthorize(DASHBOARD, await createPkcePair(), { cookie });
    expect(atDashboard.status).toBe(303);
    expect(locationParams(atDashboard).get("code")).toBeTruthy();

    // B へは **同じ Cookie のまま**向かう。ここで 200（同意画面）が返るのが
    // SSO が成立している状態。誰として許可するのかまで画面に出ている。
    const partnerPkce = await createPkcePair();
    const atPartner = await requestAuthorize(PARTNER, partnerPkce, { cookie });
    expect(sentToLogin(atPartner), "B で再ログインを要求された").toBe(false);
    expect(atPartner.status).toBe(200);
    expect(await atPartner.clone().text()).toContain(user.displayName);

    // 対照群。Cookie を外した同じ要求はログイン画面へ送られる。これが無いと
    // 「誰でもコードが出る実装」でも上の 2 つは緑になる。
    const anonymous = await requestAuthorize(PARTNER, partnerPkce);
    expect(sentToLogin(anonymous), "未ログインなのに素通りした").toBe(true);
  });

  it("2 つの ID Token は sub が同じで aud がそれぞれ異なる", async () => {
    const cookie = sessionCookie(user);
    const dashboardTokens = await signInToDashboard(cookie);
    const partnerTokens = await signInToPartner(cookie);

    const a = await verifyIdToken(dashboardTokens.id_token, DASHBOARD.clientId);
    const b = await verifyIdToken(partnerTokens.id_token, PARTNER.clientId);

    // 同じ人だと両サービスが合意できることが SSO の中身である。
    expect(b.sub).toBe(a.sub);
    expect(a.sub).toBe(user.userId);
    // 宛先は別。aud が同じだと、片方宛ての ID Token をもう片方が受け取れる。
    expect(a.aud).toBe(DASHBOARD.clientId);
    expect(b.aud).toBe(PARTNER.clientId);
    expect(a.iss).toBe(b.iss);

    // 対照群。sub が「常に同じ値」なのではなく、**セッションの持ち主**を
    // 指していること。別のブラウザ（別セッション・別ユーザー）で B を
    // 回すと別の sub になる。
    const another = await seedLoggedInUser();
    const others = await signInToPartner(sessionCookie(another));
    const c = await verifyIdToken(others.id_token, PARTNER.clientId);
    expect(c.sub).not.toBe(a.sub);
  });

  it("A 宛ての ID Token を B が受け取っても aud 検証で落ちる", async () => {
    const cookie = sessionCookie(user);
    const dashboardTokens = await signInToDashboard(cookie);

    // 対照群: 正しい宛先なら通る（鍵も iss も正しいことの確認）。
    await expect(verifyIdToken(dashboardTokens.id_token, DASHBOARD.clientId)).resolves.toBeTruthy();

    // B が RP として検証すれば落ちる。SSO で sub を共有していても、
    // 「A にログインした事実」を B へのログインとして使い回せてはならない。
    //
    // 失敗の理由まで固定する。単に throw したことだけを見ると、鍵が引けない
    // ような別の理由で落ちていても緑になり、aud を検証できているか分からない。
    await expect(verifyIdToken(dashboardTokens.id_token, PARTNER.clientId)).rejects.toMatchObject({
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim: "aud",
    });
  });
});

describe("first-party と third-party で同意の扱いが違う", () => {
  it("A は同意画面を省略し、B は同意を取る", async () => {
    const cookie = sessionCookie(user);

    // 同じセッション・同じ scope でも、クライアントの属性で分岐する。
    // 片方だけを見ても「省略した」のか「そもそも同意画面が無い」のかは
    // 区別できないので、2 つを並べて 1 つのテストにしている。
    const atDashboard = await requestAuthorize(DASHBOARD, await createPkcePair(), { cookie });
    expect(atDashboard.status).toBe(303);
    expect(locationParams(atDashboard).get("code")).toBeTruthy();

    const atPartner = await requestAuthorize(PARTNER, await createPkcePair(), { cookie });
    expect(atPartner.status).toBe(200);
    expect(atPartner.headers.get("Location")).toBeNull();
    expect(await atPartner.text()).toContain("へのアクセスを許可しますか？");
  });

  it("同意の記録はクライアントごとに別々の行になる", async () => {
    const cookie = sessionCookie(user);
    await signInToDashboard(cookie);
    await signInToPartner(cookie);

    // 画面を省略した A の分も残る（省略は「同意が要らない」ではなく
    // 「訊かずに記録する」という意味）。1 行にまとめてしまうと、
    // 片方だけ取り消すことができなくなる。
    const grants = await db().select().from(oauthGrants).all();
    expect(grants.map((row) => row.clientId).sort()).toEqual([dashboard.id, partner.id].sort());
    expect(new Set(grants.map((row) => row.userId))).toEqual(new Set([user.userId]));
  });
});

describe("トークンは発行先のクライアントに閉じている", () => {
  it("Access Token の audience がクライアントごとに分かれている", async () => {
    const cookie = sessionCookie(user);
    const dashboardTokens = await signInToDashboard(cookie);
    const partnerTokens = await signInToPartner(cookie);

    const rows = await db().select().from(oauthTokens).all();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.audience))).toEqual(
      new Set([DASHBOARD.clientId, PARTNER.clientId]),
    );
    expect(new Set(rows.map((row) => row.clientId))).toEqual(new Set([dashboard.id, partner.id]));

    // 不透明トークンそのものも共有されていない（決定 14-1 の 5）。
    expect(dashboardTokens.access_token).not.toBe(partnerTokens.access_token);
  });

  it("B は A の Access Token を失効させられない", async () => {
    const cookie = sessionCookie(user);
    const dashboardTokens = await signInToDashboard(cookie);
    await signInToPartner(cookie);

    // `/oauth/userinfo` は audience で絞らない（claim の持ち主は利用者であって
    // クライアントではない。`oauth-userinfo.test.ts` 参照）。そのため
    // 「A のトークンを B が使えない」が効いてくるのは、RP 側の aud 検証と、
    // **他人のトークンに手を出せないこと**の 2 点である。後者をここで見る。
    const revoked = await fetchApp(
      new Request(`${BASE}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: PARTNER.clientId,
          token: dashboardTokens.access_token,
        }).toString(),
      }),
      appEnv(signingKey),
    );
    // トークンの実在を漏らさないため応答は 200 だが、実際には失効しない。
    expect(revoked.status).toBe(200);

    const stillUsable = await userinfoRequest(dashboardTokens.access_token, {
      env: appEnv(signingKey),
    });
    expect(stillUsable.status, "他クライアントに失効させられてしまった").toBe(200);
  });
});

describe("ログアウトは 2 クライアントの両方に効く", () => {
  it("ログアウト後は A も B も再ログインを要求する", async () => {
    const cookie = sessionCookie(user);

    // 対照群を先に置く。ログアウト前は両方とも素通りする。
    expect(sentToLogin(await requestAuthorize(DASHBOARD, await createPkcePair(), { cookie }))).toBe(
      false,
    );
    expect(sentToLogin(await requestAuthorize(PARTNER, await createPkcePair(), { cookie }))).toBe(
      false,
    );

    expect((await logout(cookie)).status).toBe(204);

    // セッションは 1 本しかないので、落とせば両方が巻き戻る。
    // 片方だけ効く実装（クライアントごとにログイン状態を持つ等）だと
    // 「ログアウトしたのにまだ入れる」事故になる。
    expect(sentToLogin(await requestAuthorize(DASHBOARD, await createPkcePair(), { cookie }))).toBe(
      true,
    );
    expect(sentToLogin(await requestAuthorize(PARTNER, await createPkcePair(), { cookie }))).toBe(
      true,
    );
  });

  it("ログアウトが届くのは認可だけで、発行済みの Access Token には届かない", async () => {
    const cookie = sessionCookie(user);
    const dashboardTokens = await signInToDashboard(cookie);
    await logout(cookie);

    // ログアウトが失効させるのはセッションと**未交換の**認可コードまで
    // （`LogoutUseCase`）。交換済みの Access Token は 10 分で切れるか、
    // `/oauth/revoke`・同意の取り消しで消す（仕様書 7.2・決定 14-1 の 5）。
    // この境界を書いておかないと、「ログアウトしたので全部止まったはず」と
    // 読む人が出る。止めたいなら同意の取り消しを使う（下の describe）。
    const response = await userinfoRequest(dashboardTokens.access_token, {
      env: appEnv(signingKey),
    });
    expect(response.status).toBe(200);
  });
});

describe("セッション失効（DELETE /api/me/sessions/:id）も両方に効く", () => {
  it("別経路でセッションを落としても A・B ともに再ログインになる", async () => {
    const cookie = sessionCookie(user);

    // 対照群。失効前は両方とも通る。
    expect(sentToLogin(await requestAuthorize(DASHBOARD, await createPkcePair(), { cookie }))).toBe(
      false,
    );
    expect(sentToLogin(await requestAuthorize(PARTNER, await createPkcePair(), { cookie }))).toBe(
      false,
    );

    const revoked = await revokeSession(cookie, user.sessionId);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ revoked: true, self: true });

    // ログアウトと同じ結果になること。利用者から見れば「このブラウザの
    // ログインを止める」操作が 2 通りあるだけで、効き方が違っては困る。
    expect(sentToLogin(await requestAuthorize(DASHBOARD, await createPkcePair(), { cookie }))).toBe(
      true,
    );
    expect(sentToLogin(await requestAuthorize(PARTNER, await createPkcePair(), { cookie }))).toBe(
      true,
    );
  });
});

describe("片方の同意の取り消しはもう片方に波及しない", () => {
  it("B の同意を取り消しても A はコードを出し続け、B だけ同意画面に戻る", async () => {
    const cookie = sessionCookie(user);
    await signInToDashboard(cookie);
    await signInToPartner(cookie);

    const rpc = new IdentityRPC(createExecutionContext(), appEnv(signingKey));
    const result = await rpc.revokeGrant({
      sessionToken: user.sessionToken,
      clientId: PARTNER.clientId,
    });
    expect(result.ok).toBe(true);

    // B は同意からやり直し。
    const atPartner = await requestAuthorize(PARTNER, await createPkcePair(), { cookie });
    expect(atPartner.status).toBe(200);
    expect(await atPartner.text()).toContain("へのアクセスを許可しますか？");

    // 対照群。A は何も変わらない。クライアントの内部 ID ではなく
    // 利用者単位で消していると、ここで A も巻き添えになる。
    const atDashboard = await requestAuthorize(DASHBOARD, await createPkcePair(), { cookie });
    expect(atDashboard.status).toBe(303);
    expect(locationParams(atDashboard).get("code")).toBeTruthy();

    // セッション自体は生きている（同意の取り消しはログアウトではない）。
    expect(sentToLogin(atDashboard)).toBe(false);
  });

  it("取り消した側のトークンだけが失効する", async () => {
    const cookie = sessionCookie(user);
    const dashboardTokens = await signInToDashboard(cookie);
    const partnerTokens = await signInToPartner(cookie);

    const rpc = new IdentityRPC(createExecutionContext(), appEnv(signingKey));
    await rpc.revokeGrant({ sessionToken: user.sessionToken, clientId: PARTNER.clientId });

    const forPartner = await userinfoRequest(partnerTokens.access_token, {
      env: appEnv(signingKey),
    });
    expect(forPartner.status, "取り消したのにトークンが生きている").toBe(401);

    // 対照群。A のトークンは無傷。`revokeByGrant` が grant 単位で絞れて
    // いなければ、ここで A のトークンまで落ちる。
    const forDashboard = await userinfoRequest(dashboardTokens.access_token, {
      env: appEnv(signingKey),
    });
    expect(forDashboard.status, "関係ないクライアントのトークンを巻き込んだ").toBe(200);

    const rows = await db()
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.clientId, dashboard.id))
      .all();
    expect(rows.every((row) => row.revokedAt === null)).toBe(true);
  });
});
