import {
  auditLogs,
  oauthAuthorizationCodes,
  oauthClients,
  oauthGrants,
  oauthTokens,
} from "@u18/db";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { resetDatabase } from "./helpers";
import {
  appEnv,
  authorize,
  fetchApp,
  authorizeQuery,
  CONFIDENTIAL_CLIENT_ID,
  CONFIDENTIAL_SECRET,
  createPkcePair,
  db,
  locationParams,
  PUBLIC_CLIENT_ID,
  REDIRECT_URI,
  seedClient,
  seedDefaultClients,
  seedLoggedInUser,
  seedSigningKey,
  sessionCookie,
  tokenRequest,
  type PkcePair,
  type SeededClient,
  type SeededUser,
  type SigningKey,
} from "./helpers.oauth";

/**
 * `POST /oauth/token`（#16 / 仕様書 5.3・7.3・9）。
 *
 * コードは必ず `/oauth/authorize` を実際に叩いて作る。テストから
 * `oauth_authorization_codes` へ直接行を入れると、authorize が保存し
 * そこねた列があってもこのテストは通ってしまう——つまり「2 つの
 * エンドポイントが同じ前提を共有していること」を検証できなくなる。
 */

const ISSUER = "http://localhost:8787";

let firstParty: SeededClient;
let thirdParty: SeededClient;
let user: SeededUser;
let pkce: PkcePair;
let signingKey: SigningKey;

beforeEach(async () => {
  await resetDatabase();
  ({ firstParty, thirdParty } = await seedDefaultClients());
  user = await seedLoggedInUser();
  pkce = await createPkcePair();
  signingKey = await seedSigningKey();
});

/** `/oauth/authorize` を通してコードを 1 本取る。 */
async function obtainCode(overrides: Record<string, string | undefined> = {}): Promise<string> {
  const response = await authorize(
    authorizeQuery({ code_challenge: pkce.challenge, ...overrides }),
    { cookie: sessionCookie(user), env: appEnv(signingKey) },
  );
  const code = locationParams(response).get("code");
  if (code === null) throw new Error(`コードが得られなかった: ${response.headers.get("Location")}`);
  return code;
}

/** 正常な交換要求（confidential / client_secret_post）。 */
function exchange(overrides: Record<string, string | undefined> = {}) {
  return tokenRequest(
    {
      grant_type: "authorization_code",
      client_id: CONFIDENTIAL_CLIENT_ID,
      client_secret: CONFIDENTIAL_SECRET,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.verifier,
      ...overrides,
    },
    { env: appEnv(signingKey) },
  );
}

type TokenResponse = {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

describe("正常系", () => {
  it("access_token / id_token / token_type / expires_in / scope を返す", async () => {
    const code = await obtainCode();
    const response = await exchange({ code });

    expect(response.status).toBe(200);
    // トークンを中間キャッシュにもブラウザにも残さない（RFC 6749 §5.1）。
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const body = (await response.json()) as TokenResponse;
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(600);
    expect(body.scope).toBe("openid profile email");
    expect(body.access_token).toBeTruthy();
    expect(body.id_token).toBeTruthy();
  });

  it("ID Token が JWKS の公開鍵で検証でき、claim が正しい", async () => {
    const code = await obtainCode({ nonce: "nonce-abc" });
    const body = (await (await exchange({ code })).json()) as TokenResponse;

    const header = decodeProtectedHeader(body.id_token);
    // alg は ES256 固定。kid が無いと RP は JWKS のどの鍵か決められない。
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe(signingKey.kid);

    const jwks = createLocalJWKSet({ keys: [signingKey.publicJwk] });
    const { payload } = await jwtVerify(body.id_token, jwks, {
      issuer: ISSUER,
      audience: CONFIDENTIAL_CLIENT_ID,
    });

    expect(payload.sub).toBe(user.userId);
    expect(payload.nonce).toBe("nonce-abc");
    expect(payload["auth_time"]).toBe(Math.floor(user.authTime.getTime() / 1000));
    // ID Token は 5 分（仕様書 5.3）。
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
    // profile / email scope に応じた claim。
    expect(payload["preferred_username"]).toBe(user.username);
    expect(payload["email"]).toBe(user.email);
  });

  it("nonce が無ければ claim 自体を出さない", async () => {
    const code = await obtainCode();
    const body = (await (await exchange({ code })).json()) as TokenResponse;

    const jwks = createLocalJWKSet({ keys: [signingKey.publicJwk] });
    const { payload } = await jwtVerify(body.id_token, jwks);
    // `"nonce": null` を載せると、null 同士で一致してしまう RP 実装がある。
    expect("nonce" in payload).toBe(false);
  });

  it("openid だけの scope では profile / email claim を出さない", async () => {
    const code = await obtainCode({ scope: "openid" });
    const body = (await (await exchange({ code })).json()) as TokenResponse;

    const jwks = createLocalJWKSet({ keys: [signingKey.publicJwk] });
    const { payload } = await jwtVerify(body.id_token, jwks);

    expect(payload.sub).toBe(user.userId);
    expect("email" in payload).toBe(false);
    expect("preferred_username" in payload).toBe(false);
    expect(body.scope).toBe("openid");
  });

  it("Access Token は不透明で、DB にはハッシュしか入らない（決定 14-1 の 5）", async () => {
    const code = await obtainCode();
    const body = (await (await exchange({ code })).json()) as TokenResponse;

    // JWT ではない（ドットで 3 つに割れない）。
    expect(body.access_token.split(".")).toHaveLength(1);

    const row = await db().select().from(oauthTokens).get();
    expect(row).toBeDefined();
    expect(row!.tokenHash).not.toBe(body.access_token);
    expect(row!.tokenHash).toBe(await new Sha256TokenHasher().hash(body.access_token));
    expect(row!.tokenType).toBe("access");
    expect(row!.audience).toBe(CONFIDENTIAL_CLIENT_ID);
    expect(row!.scope).toBe("openid profile email");
    expect(row!.revokedAt).toBeNull();
    // Access Token は 10 分（仕様書 5.3）。
    const lifetimeMs = row!.expiresAt.getTime() - row!.createdAt.getTime();
    expect(lifetimeMs).toBeLessThanOrEqual(600_000);
    expect(lifetimeMs).toBeGreaterThan(599_000);
  });

  it("Refresh Token は発行しない（仕様書 1.2）", async () => {
    const code = await obtainCode();
    const body = (await (await exchange({ code })).json()) as Record<string, unknown>;

    expect("refresh_token" in body).toBe(false);
    const rows = await db().select().from(oauthTokens).all();
    expect(rows.every((row) => row.tokenType === "access")).toBe(true);
  });

  it("client_secret_basic でも交換できる", async () => {
    const code = await obtainCode();
    const response = await tokenRequest(
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: pkce.verifier,
      },
      {
        basic: { id: CONFIDENTIAL_CLIENT_ID, secret: CONFIDENTIAL_SECRET },
        env: appEnv(signingKey),
      },
    );

    expect(response.status).toBe(200);
  });

  it("public クライアントは PKCE だけで交換できる", async () => {
    // third-party なので同意を先に済ませておく。
    await db()
      .insert(oauthGrants)
      .values({
        id: "grt_public",
        userId: user.userId,
        clientId: thirdParty.id,
        grantedScopes: "openid profile email",
        grantedAt: new Date(),
      })
      .run();

    const code = await obtainCode({ client_id: PUBLIC_CLIENT_ID });
    const response = await tokenRequest(
      {
        grant_type: "authorization_code",
        client_id: PUBLIC_CLIENT_ID,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: pkce.verifier,
      },
      { env: appEnv(signingKey) },
    );

    expect(response.status).toBe(200);
  });
});

describe("認可コードの単回交換", () => {
  it("2 回目の交換は invalid_grant になる", async () => {
    const code = await obtainCode();
    expect((await exchange({ code })).status).toBe(200);

    const replay = await exchange({ code });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("2 回目の交換で 1 回目に発行したトークンが失効する（RFC 9700 §4.1.2）", async () => {
    const code = await obtainCode();
    const body = (await (await exchange({ code })).json()) as TokenResponse;

    const hash = await new Sha256TokenHasher().hash(body.access_token);
    expect(
      (await db().select().from(oauthTokens).where(eq(oauthTokens.tokenHash, hash)).get())
        ?.revokedAt,
    ).toBeNull();

    await exchange({ code });

    // 消費済みのコードがもう一度提示された＝そのコードが 2 箇所に存在した。
    // 1 回目のトークンが攻撃者の手元にある可能性があるので生かしておかない。
    const after = await db()
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.tokenHash, hash))
      .get();
    expect(after?.revokedAt).not.toBeNull();
  });

  it("リプレイを監査ログ oauth.code.replayed に残す", async () => {
    const code = await obtainCode();
    await exchange({ code });
    await exchange({ code });

    const events = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, "oauth.code.replayed"))
      .all();
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe("failure");
  });

  it("60 秒を過ぎたコードを拒否する", async () => {
    const code = await obtainCode();

    // 時計を進める代わりに期限を過去へ倒す。`consume` の WHERE 句が見るのは
    // `expires_at > now` なので、どちらでも同じ条件を試せる。
    await db()
      .update(oauthAuthorizationCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run();

    const response = await exchange({ code });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("期限切れのコードはリプレイ扱いにしない（トークンを巻き込まない）", async () => {
    const code = await obtainCode();
    await db()
      .update(oauthAuthorizationCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run();
    await exchange({ code });

    const events = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, "oauth.code.replayed"))
      .all();
    expect(events).toHaveLength(0);
  });

  it("存在しないコードも同じ invalid_grant に畳む", async () => {
    const response = await exchange({ code: "not-a-real-code" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });
});

describe("PKCE", () => {
  it("誤った code_verifier を拒否する", async () => {
    const code = await obtainCode();
    const other = await createPkcePair();

    const response = await exchange({ code, code_verifier: other.verifier });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("code_verifier の欠落を拒否する", async () => {
    const code = await obtainCode();
    const response = await exchange({ code, code_verifier: undefined });
    expect(response.status).toBe(400);
  });

  it("形式不正な code_verifier を拒否する（42 文字）", async () => {
    const code = await obtainCode();
    const response = await exchange({ code, code_verifier: "a".repeat(42) });
    expect(response.status).toBe(400);
  });

  it("PKCE に落ちたコードは消費済みのままで、やり直せない", async () => {
    const code = await obtainCode();
    const other = await createPkcePair();

    await exchange({ code, code_verifier: other.verifier });
    // 正しい verifier でも通らない。「当たるまで試せるコード」を作らない。
    const retry = await exchange({ code });
    expect(retry.status).toBe(400);
  });
});

describe("クライアントと宛先の一致", () => {
  it("別クライアントの認証情報では交換できない", async () => {
    await seedClient({
      clientId: "other-client",
      clientType: "confidential",
      isFirstParty: true,
      secret: "other-secret",
    });
    const code = await obtainCode();

    const response = await exchange({
      code,
      client_id: "other-client",
      client_secret: "other-secret",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("authorize 時と異なる redirect_uri を拒否する", async () => {
    await seedClient({
      clientId: "two-uris",
      clientType: "confidential",
      isFirstParty: true,
      secret: "s",
      redirectUris: [REDIRECT_URI, "https://app.example/other"],
    });

    const response = await authorize(
      authorizeQuery({ client_id: "two-uris", code_challenge: pkce.challenge }),
      { cookie: sessionCookie(user), env: appEnv(signingKey) },
    );
    const code = locationParams(response).get("code") ?? "";

    const exchanged = await exchange({
      code,
      client_id: "two-uris",
      client_secret: "s",
      // 登録済みだが authorize で使っていない宛先。
      redirect_uri: "https://app.example/other",
    });
    expect(exchanged.status).toBe(400);
    expect(await exchanged.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("redirect_uri の欠落を拒否する", async () => {
    const code = await obtainCode();
    const response = await exchange({ code, redirect_uri: undefined });
    expect(response.status).toBe(400);
  });
});

describe("クライアント認証", () => {
  it("誤った client_secret は 401 invalid_client", async () => {
    const code = await obtainCode();
    const response = await exchange({ code, client_secret: "wrong" });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });

  it("confidential クライアントが秘密を出さないと拒否する", async () => {
    const code = await obtainCode();
    const response = await exchange({ code, client_secret: undefined });
    expect(response.status).toBe(401);
  });

  it("public クライアントが秘密を出すと拒否する", async () => {
    const response = await tokenRequest(
      {
        grant_type: "authorization_code",
        client_id: PUBLIC_CLIENT_ID,
        client_secret: "anything",
        code: "x",
        redirect_uri: REDIRECT_URI,
        code_verifier: pkce.verifier,
      },
      { env: appEnv(signingKey) },
    );
    expect(response.status).toBe(401);
  });

  it("Basic と POST の併用を拒否する（RFC 6749 §2.3.1）", async () => {
    const response = await tokenRequest(
      {
        grant_type: "authorization_code",
        client_id: CONFIDENTIAL_CLIENT_ID,
        client_secret: CONFIDENTIAL_SECRET,
        code: "x",
        redirect_uri: REDIRECT_URI,
        code_verifier: pkce.verifier,
      },
      {
        basic: { id: CONFIDENTIAL_CLIENT_ID, secret: CONFIDENTIAL_SECRET },
        env: appEnv(signingKey),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("Basic とボディで別の client_id を名乗ると拒否する", async () => {
    const response = await tokenRequest(
      {
        grant_type: "authorization_code",
        client_id: PUBLIC_CLIENT_ID,
        code: "x",
        redirect_uri: REDIRECT_URI,
        code_verifier: pkce.verifier,
      },
      {
        basic: { id: CONFIDENTIAL_CLIENT_ID, secret: CONFIDENTIAL_SECRET },
        env: appEnv(signingKey),
      },
    );

    expect(response.status).toBe(400);
  });

  it("401 には WWW-Authenticate を付ける（RFC 6749 §5.2）", async () => {
    const response = await tokenRequest(
      {
        grant_type: "authorization_code",
        code: "x",
        redirect_uri: REDIRECT_URI,
        code_verifier: pkce.verifier,
      },
      { basic: { id: CONFIDENTIAL_CLIENT_ID, secret: "wrong" }, env: appEnv(signingKey) },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toMatch(/^Basic /);
  });

  it("失効したクライアントは交換できない", async () => {
    const code = await obtainCode();
    await db()
      .update(oauthClients)
      .set({ disabledAt: new Date() })
      .where(eq(oauthClients.id, firstParty.id))
      .run();

    const response = await exchange({ code });
    expect(response.status).toBe(401);
  });
});

describe("grant_type", () => {
  it.each(["password", "refresh_token", "implicit", "client_credentials"])(
    "%s を拒否する",
    async (grantType) => {
      const response = await exchange({ grant_type: grantType, code: "x" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "unsupported_grant_type" });
    },
  );

  it("grant_type の欠落を拒否する", async () => {
    const response = await exchange({ grant_type: undefined, code: "x" });
    expect(response.status).toBe(400);
  });
});

describe("authorize 後に状況が変わった場合", () => {
  it("同意が取り消されていたら交換できない", async () => {
    const code = await obtainCode();

    await db()
      .update(oauthGrants)
      .set({ revokedAt: new Date() })
      .where(eq(oauthGrants.clientId, firstParty.id))
      .run();

    const response = await exchange({ code });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("署名鍵が未設定なら 500 server_error（invalid_* に混ぜない）", async () => {
    const code = await obtainCode();

    const response = await tokenRequest(
      {
        grant_type: "authorization_code",
        client_id: CONFIDENTIAL_CLIENT_ID,
        client_secret: CONFIDENTIAL_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: pkce.verifier,
      },
      // 鍵を渡さない＝ Workers Secret 未設定。
      { env: appEnv() },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "server_error" });
    // 署名に失敗しても Access Token の行は作らない（ID Token が先）。
    expect(await db().select().from(oauthTokens).all()).toHaveLength(0);
  });
});

describe("ログアウトの連鎖失効（#15）", () => {
  it("ログアウト後は未交換のコードを交換できない", async () => {
    const code = await obtainCode();

    const logout = await fetchLogout();
    expect(logout.status).toBe(204);

    const response = await exchange({ code });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("連鎖失効はリプレイ検出を誤作動させない", async () => {
    const code = await obtainCode();
    await fetchLogout();
    await exchange({ code });

    // `consumed_at` ではなく `expires_at` で失効させているので、
    // 期限切れ（unusable）として扱われ、トークンは巻き込まれない。
    const events = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, "oauth.code.replayed"))
      .all();
    expect(events).toHaveLength(0);
  });
});

/** JSON API のログアウト。Origin 検証を通すためヘッダを付ける。 */
function fetchLogout(): Promise<Response> {
  return fetchApp(
    new Request("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { Cookie: sessionCookie(user), Origin: ISSUER },
    }),
    appEnv(signingKey),
  );
}
