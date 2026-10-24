import { auditLogs, oauthGrants, oauthTokens } from "@u18/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { resetDatabase } from "./helpers";
import {
  appEnv,
  authorize,
  authorizeQuery,
  CONFIDENTIAL_CLIENT_ID,
  CONFIDENTIAL_SECRET,
  createPkcePair,
  db,
  locationParams,
  PUBLIC_CLIENT_ID,
  REDIRECT_URI,
  revokeRequest,
  seedDefaultClients,
  seedLoggedInUser,
  seedSigningKey,
  sessionCookie,
  tokenRequest,
  userinfoRequest,
  type SeededClient,
  type SeededUser,
  type SigningKey,
} from "./helpers.oauth";

/**
 * `POST /oauth/revoke`（#17 / RFC 7009）。
 *
 * このファイルの大半は「**違いが外から見えないこと**」を確かめている。
 * 普通のテストは「正しい入力に正しい応答が返る」を見るが、失効
 * エンドポイントで本当に危ないのは、応答の差がトークンの実在を測る
 * 物差しになってしまうことのほうである。
 */

let thirdParty: SeededClient;
let user: SeededUser;
let signingKey: SigningKey;

beforeEach(async () => {
  await resetDatabase();
  ({ thirdParty } = await seedDefaultClients());
  user = await seedLoggedInUser();
  signingKey = await seedSigningKey();
});

/**
 * Code Flow を 1 周して Access Token を取る。クライアントは選べる。
 *
 * public（third-party）側は同意画面を挟むので、同意の行を先に入れておく
 * ——ここで確かめたいのは失効の挙動であって同意画面ではない
 * （`oauth-token.test.ts` と同じ方針）。
 */
async function obtainAccessToken(
  client: "confidential" | "public" = "confidential",
): Promise<string> {
  const verifier = await createPkcePair();
  const clientId = client === "confidential" ? CONFIDENTIAL_CLIENT_ID : PUBLIC_CLIENT_ID;

  if (client === "public") {
    await db()
      .insert(oauthGrants)
      .values({
        id: `grt_public_${crypto.randomUUID()}`,
        userId: user.userId,
        clientId: thirdParty.id,
        grantedScopes: "openid profile email",
        grantedAt: new Date(),
      })
      .onConflictDoNothing()
      .run();
  }

  const authorized = await authorize(
    authorizeQuery({ client_id: clientId, code_challenge: verifier.challenge }),
    { cookie: sessionCookie(user), env: appEnv(signingKey) },
  );
  const code = locationParams(authorized).get("code");
  if (code === null) {
    throw new Error(`コードが得られなかった: ${authorized.headers.get("Location")}`);
  }

  const response = await tokenRequest(
    {
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: client === "confidential" ? CONFIDENTIAL_SECRET : undefined,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: verifier.verifier,
    },
    { env: appEnv(signingKey) },
  );

  expect(response.status, "トークン交換に失敗した").toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** confidential クライアントとしての失効要求（client_secret_post）。 */
function revokeAsFirstParty(token: string | undefined, extra: Record<string, string> = {}) {
  return revokeRequest({
    token,
    client_id: CONFIDENTIAL_CLIENT_ID,
    client_secret: CONFIDENTIAL_SECRET,
    ...extra,
  });
}

async function tokenRow(accessToken: string) {
  const hash = await new Sha256TokenHasher().hash(accessToken);
  return await db().select().from(oauthTokens).where(eq(oauthTokens.tokenHash, hash)).get();
}

describe("自分が発行されたトークンの失効", () => {
  it("200 を返し、revoked_at が立つ", async () => {
    const accessToken = await obtainAccessToken();
    const response = await revokeAsFirstParty(accessToken);

    expect(response.status).toBe(200);
    expect((await tokenRow(accessToken))?.revokedAt).not.toBeNull();
  });

  it("本文を返さない（RFC 7009 §2.2）", async () => {
    const accessToken = await obtainAccessToken();
    const response = await revokeAsFirstParty(accessToken);

    // ここで `{ revoked: true }` のような本文を足すと、「実在したか」が
    // そのまま漏れる。本文を持たないことが保証そのものになっている。
    expect(await response.text()).toBe("");
  });

  it("失効後は同じトークンで userinfo が 401 になる", async () => {
    // 受け入れ条件の本体。不透明トークン + DB 失効（決定 14-1 の 5）を
    // 選んだ意味は、この 1 本が通ることに尽きる。
    const accessToken = await obtainAccessToken();
    expect((await userinfoRequest(accessToken)).status).toBe(200);

    await revokeAsFirstParty(accessToken);

    const after = await userinfoRequest(accessToken);
    expect(after.status).toBe(401);
    expect(after.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  it("client_secret_basic でも失効できる", async () => {
    // RFC 7009 §2.1 は `/oauth/token` と同じ認証方式を求めている。
    const accessToken = await obtainAccessToken();
    const response = await revokeRequest(
      { token: accessToken },
      { basic: { id: CONFIDENTIAL_CLIENT_ID, secret: CONFIDENTIAL_SECRET } },
    );

    expect(response.status).toBe(200);
    expect((await tokenRow(accessToken))?.revokedAt).not.toBeNull();
  });

  it("public クライアントは client_id だけで失効できる", async () => {
    const accessToken = await obtainAccessToken("public");
    const response = await revokeRequest({ token: accessToken, client_id: PUBLIC_CLIENT_ID });

    expect(response.status).toBe(200);
    expect((await tokenRow(accessToken))?.revokedAt).not.toBeNull();
  });

  it("応答をキャッシュさせない", async () => {
    // 「200 だった」がキャッシュされると、2 回目の失効要求が実際には届かない。
    const response = await revokeAsFirstParty(await obtainAccessToken());

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("冪等である", () => {
  it("2 回失効させても 200", async () => {
    const accessToken = await obtainAccessToken();
    const first = await revokeAsFirstParty(accessToken);
    const second = await revokeAsFirstParty(accessToken);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("2 回目は revoked_at を上書きしない", async () => {
    // 上書きすると「いつ失効させたか」の記録が最後の要求で塗り替わる。
    const accessToken = await obtainAccessToken();
    await revokeAsFirstParty(accessToken);
    const first = (await tokenRow(accessToken))?.revokedAt;

    await revokeAsFirstParty(accessToken);

    expect((await tokenRow(accessToken))?.revokedAt?.getTime()).toBe(first?.getTime());
  });

  it("期限切れのトークンでも 200", async () => {
    const accessToken = await obtainAccessToken();
    const hash = await new Sha256TokenHasher().hash(accessToken);
    await db()
      .update(oauthTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthTokens.tokenHash, hash))
      .run();

    expect((await revokeAsFirstParty(accessToken)).status).toBe(200);
  });
});

describe("トークンの実在を漏らさない", () => {
  it("未知のトークンでも 200", async () => {
    const response = await revokeAsFirstParty("totally-made-up-token");

    expect(response.status).toBe(200);
  });

  it("未知のトークンと実在のトークンで応答が区別できない", async () => {
    // 1 要求につき 1 ビットでも漏れれば、総当たりの効率がそのぶん上がる。
    const real = await revokeAsFirstParty(await obtainAccessToken());
    const fake = await revokeAsFirstParty("totally-made-up-token");

    expect(fake.status).toBe(real.status);
    expect(await fake.text()).toBe(await real.text());
  });

  it("他人のトークンでも 200", async () => {
    const accessToken = await obtainAccessToken("public");
    const response = await revokeAsFirstParty(accessToken);

    expect(response.status).toBe(200);
  });

  it("他人のトークンの応答が、自分のトークンの応答と区別できない", async () => {
    // 403 を返す実装は「実在し、かつ別のクライアントのものだ」まで教える。
    const mine = await revokeAsFirstParty(await obtainAccessToken());
    const theirs = await revokeAsFirstParty(await obtainAccessToken("public"));

    expect(theirs.status).toBe(mine.status);
    expect(await theirs.text()).toBe(await mine.text());
  });
});

describe("他人のトークンを失効させない", () => {
  it("別クライアントのトークンは revoked_at が立たない", async () => {
    // これを怠ると、クライアントを 1 つ登録するだけで、総当たりで当てた
    // 他社のトークンを片端から無効化できる。
    const accessToken = await obtainAccessToken("public");

    await revokeAsFirstParty(accessToken);

    expect((await tokenRow(accessToken))?.revokedAt).toBeNull();
  });

  it("失効させられなかったトークンは引き続き userinfo で使える", async () => {
    const accessToken = await obtainAccessToken("public");

    await revokeAsFirstParty(accessToken);

    expect((await userinfoRequest(accessToken)).status).toBe(200);
  });

  it("監査ログには client_mismatch として残る", async () => {
    // 応答は区別しないが、「どのクライアントが他人のトークンを提示したか」は
    // 調査の起点になる。
    await revokeAsFirstParty(await obtainAccessToken("public"));

    const rows = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, "oauth.token.revoked"))
      .all();

    expect(rows.some((row) => row.reason === "client_mismatch")).toBe(true);
  });

  it("監査ログにトークンもそのハッシュも載らない", async () => {
    // 載せると、ログを読める者が発行応答と突き合わせられる（仕様書 9 Privacy）。
    const accessToken = await obtainAccessToken();
    const hash = await new Sha256TokenHasher().hash(accessToken);
    await revokeAsFirstParty(accessToken);

    const rows = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, "oauth.token.revoked"))
      .all();
    const dumped = JSON.stringify(rows);

    expect(dumped).not.toContain(accessToken);
    expect(dumped).not.toContain(hash);
  });
});

describe("クライアント認証より手前の失敗だけが 4xx", () => {
  it("client_id が無ければ 400", async () => {
    const response = await revokeRequest({ token: "anything" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("client_secret が違えば 401", async () => {
    const response = await revokeRequest({
      token: "anything",
      client_id: CONFIDENTIAL_CLIENT_ID,
      client_secret: "wrong-secret",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });

  it("Basic で認証を試みた 401 には WWW-Authenticate が付く（RFC 6749 §5.2）", async () => {
    const response = await revokeRequest(
      { token: "anything" },
      { basic: { id: CONFIDENTIAL_CLIENT_ID, secret: "wrong-secret" } },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Basic realm="u18-identity"');
  });

  it("public クライアントが secret を出せば 401", async () => {
    // 受け入れると「秘密を知っている＝認証済み」が public にも生まれる。
    const response = await revokeRequest({
      token: "anything",
      client_id: PUBLIC_CLIENT_ID,
      client_secret: "some-secret",
    });

    expect(response.status).toBe(401);
  });

  it("Basic と本文の両方に秘密を載せれば 400", async () => {
    // RFC 6749 §2.3.1 は複数方式の併用を禁じている。
    const response = await revokeRequest(
      { token: "anything", client_secret: CONFIDENTIAL_SECRET },
      { basic: { id: CONFIDENTIAL_CLIENT_ID, secret: CONFIDENTIAL_SECRET } },
    );

    expect(response.status).toBe(400);
  });

  it("token パラメータが無ければ 400", async () => {
    // 要求の形の問題で、トークンの状態について何も語らない。
    const response = await revokeAsFirstParty(undefined);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("認証に失敗した要求では DB を触らない", async () => {
    // 認証をトークンの存在確認より先に置いているので、未認証の要求が
    // 失効を引き起こすことはない。
    const accessToken = await obtainAccessToken();

    await revokeRequest({
      token: accessToken,
      client_id: CONFIDENTIAL_CLIENT_ID,
      client_secret: "wrong-secret",
    });

    expect((await tokenRow(accessToken))?.revokedAt).toBeNull();
  });
});

describe("token_type_hint", () => {
  it("access_token の hint を付けても失効する", async () => {
    const accessToken = await obtainAccessToken();
    const response = await revokeAsFirstParty(accessToken, { token_type_hint: "access_token" });

    expect(response.status).toBe(200);
    expect((await tokenRow(accessToken))?.revokedAt).not.toBeNull();
  });

  it("refresh_token の hint でも探索先を狭めない", async () => {
    // RFC 7009 §2.1: hint で見つからなければ他の種別も探すこと。
    // u18 は access しか持たないので「常に全部を探す」で適合する。
    const accessToken = await obtainAccessToken();
    const response = await revokeAsFirstParty(accessToken, { token_type_hint: "refresh_token" });

    expect(response.status).toBe(200);
    expect((await tokenRow(accessToken))?.revokedAt).not.toBeNull();
  });

  it("未知の hint でも 200", async () => {
    const accessToken = await obtainAccessToken();
    const response = await revokeAsFirstParty(accessToken, { token_type_hint: "nonsense" });

    expect(response.status).toBe(200);
  });
});

describe("Discovery の広告と実装が一致する", () => {
  it("revocation_endpoint が実在する", async () => {
    // 広告と挙動がずれると、RP からは原因の掴めない失敗になる。
    const response = await revokeAsFirstParty("anything");

    expect(response.status).not.toBe(404);
    expect(response.status).not.toBe(501);
  });

  it("失効させられるのは access だけ、と広告している", async () => {
    // Refresh Token は 1 本も発行しない（仕様書 1.2）。
    const rows = await db().select().from(oauthTokens).all();

    expect(rows.every((row) => row.tokenType === "access")).toBe(true);
  });
});
