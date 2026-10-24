import { oauthGrants, oauthTokens, users } from "@u18/db";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { resetDatabase } from "./helpers";
import {
  appEnv,
  authorize,
  BASE,
  authorizeQuery,
  CONFIDENTIAL_CLIENT_ID,
  CONFIDENTIAL_SECRET,
  createPkcePair,
  db,
  fetchApp,
  locationParams,
  REDIRECT_URI,
  seedDefaultClients,
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
 * `GET|POST /oauth/userinfo`（#17 / 仕様書 5.2・9）。
 *
 * トークンは必ず Code Flow を**実際に通して**取る。`oauth_tokens` へ
 * テストから直接行を入れると、`/oauth/token` が書きそこねた列（`grant_id` や
 * `audience`）があってもこのテストは通ってしまう。確かめたいのは
 * 「2 つのエンドポイントが同じ前提を共有していること」なので、
 * `oauth-token.test.ts` と同じ方針を採る。
 */

let firstParty: SeededClient;
let user: SeededUser;
let pkce: PkcePair;
let signingKey: SigningKey;

beforeEach(async () => {
  await resetDatabase();
  ({ firstParty } = await seedDefaultClients());
  user = await seedLoggedInUser();
  pkce = await createPkcePair();
  signingKey = await seedSigningKey();
});

type Tokens = { readonly accessToken: string; readonly idToken: string };

/** Code Flow を 1 周して Access Token と ID Token を取る。 */
async function obtainTokens(scope = "openid profile email"): Promise<Tokens> {
  const authorized = await authorize(authorizeQuery({ code_challenge: pkce.challenge, scope }), {
    cookie: sessionCookie(user),
    env: appEnv(signingKey),
  });
  const code = locationParams(authorized).get("code");
  if (code === null) {
    throw new Error(`コードが得られなかった: ${authorized.headers.get("Location")}`);
  }

  const response = await tokenRequest(
    {
      grant_type: "authorization_code",
      client_id: CONFIDENTIAL_CLIENT_ID,
      client_secret: CONFIDENTIAL_SECRET,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: pkce.verifier,
    },
    { env: appEnv(signingKey) },
  );

  expect(response.status, "トークン交換に失敗した").toBe(200);
  const body = (await response.json()) as { access_token: string; id_token: string };
  return { accessToken: body.access_token, idToken: body.id_token };
}

describe("有効な Access Token", () => {
  it("scope に応じた claim を返す", async () => {
    const { accessToken } = await obtainTokens();
    const response = await userinfoRequest(accessToken);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sub: user.userId,
      preferred_username: user.username,
      name: user.displayName,
      updated_at: expect.any(Number),
      email: user.email,
      email_verified: true,
    });
  });

  it("GET と POST で同じ応答を返す", async () => {
    // 仕様書 5.2 の表が両方を求めている。Bearer をヘッダからしか
    // 読まないので、メソッドによる違いは 1 つも無いはず。
    const { accessToken } = await obtainTokens();

    const get = await userinfoRequest(accessToken, { method: "GET" });
    const post = await userinfoRequest(accessToken, { method: "POST" });

    expect(get.status).toBe(200);
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual(await get.json());
  });

  it("Bearer スキームの大文字小文字を区別しない", async () => {
    // RFC 7235 §2.1。弾くと RP 側で原因の分からない 401 になる。
    const { accessToken } = await obtainTokens();
    const response = await userinfoRequest(null, {
      rawAuthorization: `bearer ${accessToken}`,
    });

    expect(response.status).toBe(200);
  });

  it("claim を中間キャッシュに残させない", async () => {
    const { accessToken } = await obtainTokens();
    const response = await userinfoRequest(accessToken);

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("sub が ID Token の sub と一致する", async () => {
    // 2 つがずれると、RP は「ログインした人」と「情報を取った人」を
    // 同一人物だと判断できなくなる（OIDC Core §5.3.2）。
    const { accessToken, idToken } = await obtainTokens();
    const response = await userinfoRequest(accessToken);
    const claims = (await response.json()) as { sub: string };

    expect(claims.sub).toBe(decodeJwt(idToken).sub);
    expect(claims.sub).toBe(user.userId);
  });
});

describe("scope による claim の絞り込み", () => {
  it("openid だけなら sub しか返さない", async () => {
    const { accessToken } = await obtainTokens("openid");
    const response = await userinfoRequest(accessToken);

    expect(await response.json()).toEqual({ sub: user.userId });
  });

  it("profile があっても email は返さない", async () => {
    const { accessToken } = await obtainTokens("openid profile");
    const claims = (await (await userinfoRequest(accessToken)).json()) as Record<string, unknown>;

    expect(claims).toHaveProperty("name");
    expect(claims).toHaveProperty("preferred_username");
    expect(claims).not.toHaveProperty("email");
    expect(claims).not.toHaveProperty("email_verified");
  });

  it("email があっても profile の claim は返さない", async () => {
    const { accessToken } = await obtainTokens("openid email");
    const claims = (await (await userinfoRequest(accessToken)).json()) as Record<string, unknown>;

    expect(claims).toHaveProperty("email");
    expect(claims).not.toHaveProperty("name");
    expect(claims).not.toHaveProperty("preferred_username");
  });
});

describe("トークンが使えないときは 401 + WWW-Authenticate", () => {
  /** RFC 6750 §3。ヘッダが無いと RP は「認証が要る」ことを機械的に判断できない。 */
  async function expectInvalidToken(response: Response): Promise<void> {
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  }

  it("未知のトークン", async () => {
    await expectInvalidToken(await userinfoRequest("not-a-real-token"));
  });

  it("失効済みのトークン", async () => {
    const { accessToken } = await obtainTokens();
    const hash = await new Sha256TokenHasher().hash(accessToken);
    await db()
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oauthTokens.tokenHash, hash))
      .run();

    await expectInvalidToken(await userinfoRequest(accessToken));
  });

  it("期限切れのトークン", async () => {
    const { accessToken } = await obtainTokens();
    const hash = await new Sha256TokenHasher().hash(accessToken);
    await db()
      .update(oauthTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthTokens.tokenHash, hash))
      .run();

    await expectInvalidToken(await userinfoRequest(accessToken));
  });

  it("同意が取り消されたトークン", async () => {
    // 同意の取り消しとトークンの失効は別テーブルへの書き込みで、
    // 原理的にずれうる。ここが最後の砦になる。
    const { accessToken } = await obtainTokens();
    await db()
      .update(oauthGrants)
      .set({ revokedAt: new Date() })
      .where(eq(oauthGrants.userId, user.userId))
      .run();

    await expectInvalidToken(await userinfoRequest(accessToken));
  });

  it("凍結されたユーザーのトークン", async () => {
    // 決定 7 により凍結アカウントの行は残り、`oauth_tokens` の行も
    // 期限まで残る。「行があるから有効」にしない。
    const { accessToken } = await obtainTokens();
    await db().update(users).set({ status: "suspended" }).where(eq(users.id, user.userId)).run();

    await expectInvalidToken(await userinfoRequest(accessToken));
  });

  it("削除されたユーザーのトークン", async () => {
    const { accessToken } = await obtainTokens();
    await db()
      .update(users)
      .set({ status: "deleted", deletedAt: new Date() })
      .where(eq(users.id, user.userId))
      .run();

    await expectInvalidToken(await userinfoRequest(accessToken));
  });

  it("凍結を解除すれば同じトークンがまた通る", async () => {
    // トークンそのものを一括失効させていないことの裏返し。凍結の解除が
    // 「状態を戻すだけ」で済むのは、この性質に依存している。
    const { accessToken } = await obtainTokens();
    await db().update(users).set({ status: "suspended" }).where(eq(users.id, user.userId)).run();
    expect((await userinfoRequest(accessToken)).status).toBe(401);

    await db().update(users).set({ status: "active" }).where(eq(users.id, user.userId)).run();

    expect((await userinfoRequest(accessToken)).status).toBe(200);
  });

  it("失敗理由を呼び分けない", async () => {
    // 「期限切れ」と「そんなトークンは無い」を区別して返すと、
    // 手元の文字列がかつて実在したかを確かめる道具になる。
    const { accessToken } = await obtainTokens();
    const hash = await new Sha256TokenHasher().hash(accessToken);
    await db()
      .update(oauthTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthTokens.tokenHash, hash))
      .run();

    const expired = await userinfoRequest(accessToken);
    const unknown = await userinfoRequest("not-a-real-token");

    expect(await expired.json()).toEqual(await unknown.json());
    expect(expired.headers.get("WWW-Authenticate")).toBe(unknown.headers.get("WWW-Authenticate"));
  });
});

describe("Bearer トークンの受け取り方", () => {
  it("Authorization ヘッダが無ければ invalid_request", async () => {
    // 「認証に失敗した」ではなく「認証がまだ無い」。invalid_token を
    // 返すと RP は手元の有効なトークンを捨ててしまう（RFC 6750 §3）。
    const response = await userinfoRequest(null);

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="u18-identity"');
    expect(response.headers.get("WWW-Authenticate")).not.toContain("invalid_token");
  });

  it("Basic 認証では受け付けない", async () => {
    const { accessToken } = await obtainTokens();
    const response = await userinfoRequest(null, {
      rawAuthorization: `Basic ${btoa(`x:${accessToken}`)}`,
    });

    expect(response.status).toBe(401);
  });

  it("クエリに載せたトークンを読まない", async () => {
    // RFC 6750 §5.3 自身が「URI クエリは使うべきでない」と書いている。
    // クエリのトークンは履歴・Referer・プロキシのアクセスログに残る。
    const { accessToken } = await obtainTokens();
    const response = await fetchApp(
      new Request(`${BASE}/oauth/userinfo?access_token=${accessToken}`),
      appEnv(),
    );

    expect(response.status).toBe(401);
  });

  it("本文に載せたトークンを読まない", async () => {
    // RFC 6750 §2.2 の form-encoded body も実装しない。受け口を増やすと
    // 「どこから来た値を検証したのか」の答えが増える。
    const { accessToken } = await obtainTokens();
    const response = await fetchApp(
      new Request(`${BASE}/oauth/userinfo`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ access_token: accessToken }).toString(),
      }),
      appEnv(),
    );

    expect(response.status).toBe(401);
  });
});

describe("他のクライアントのトークン", () => {
  it("audience には発行先の client_id が入っている", async () => {
    // userinfo 自体は audience で絞らない（claim の持ち主は利用者であって
    // クライアントではない）。ただし `/oauth/revoke` の所有者判定は
    // この列ではなく内部 ID で行うので、両者がずれないことを確かめておく。
    const { accessToken } = await obtainTokens();
    const hash = await new Sha256TokenHasher().hash(accessToken);
    const row = await db().select().from(oauthTokens).where(eq(oauthTokens.tokenHash, hash)).get();

    expect(row?.audience).toBe(CONFIDENTIAL_CLIENT_ID);
    expect(row?.clientId).toBe(firstParty.id);
  });
});
