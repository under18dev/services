import { oauthAuthorizationCodes, oauthClients, oauthGrants, oauthTokens } from "@u18/db";
import { eq } from "drizzle-orm";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { IdentityRPC } from "../src/presentation/rpc/identity.entrypoint";
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
  seedClient,
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
 * `IdentityRPC.listGrants` / `revokeGrant`（#18 / 仕様書 4.2・4.4）。
 *
 * Entrypoint を直に `new` している。Service Binding の配線そのものは
 * dashboard-worker 側の責務で、ここで確かめたいのは **DTO への写し取りと
 * 認可**——つまり「セッショントークンだけを根拠に、その人の同意だけを
 * 読み書きしているか」である。D1 は本物を使う。
 *
 * 同意とトークンは Code Flow を実際に通して作る。`oauth_grants` へ
 * 直接行を入れると、`/oauth/authorize` が書きそこねた列があっても
 * 通ってしまう（`oauth-token.test.ts` と同じ方針）。
 */

let firstParty: SeededClient;
let thirdParty: SeededClient;
let user: SeededUser;
let signingKey: SigningKey;
let rpc: IdentityRPC;

beforeEach(async () => {
  await resetDatabase();
  ({ firstParty, thirdParty } = await seedDefaultClients());
  user = await seedLoggedInUser();
  signingKey = await seedSigningKey();
  rpc = new IdentityRPC(createExecutionContext(), appEnv(signingKey));
});

/** Code Flow を 1 周し、同意と Access Token を実際に作る。 */
async function completeCodeFlow(
  client: "confidential" | "public" = "confidential",
  scope = "openid profile email",
): Promise<string> {
  const clientId = client === "confidential" ? CONFIDENTIAL_CLIENT_ID : PUBLIC_CLIENT_ID;
  const pkce = await createPkcePair();

  if (client === "public") {
    // third-party は同意画面を挟む。確かめたいのは同意画面ではないので、
    // 同意の行だけ先に入れておく。
    await db()
      .insert(oauthGrants)
      .values({
        id: `grt_${crypto.randomUUID()}`,
        userId: user.userId,
        clientId: thirdParty.id,
        grantedScopes: scope,
        grantedAt: new Date(),
      })
      .onConflictDoNothing()
      .run();
  }

  const authorized = await authorize(
    authorizeQuery({ client_id: clientId, code_challenge: pkce.challenge, scope }),
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
      code_verifier: pkce.verifier,
    },
    { env: appEnv(signingKey) },
  );

  expect(response.status, "トークン交換に失敗した").toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

describe("listGrants", () => {
  it("同意したアプリを表示情報ごと返す", async () => {
    await completeCodeFlow();
    const result = await rpc.listGrants({ sessionToken: user.sessionToken });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({
      clientId: CONFIDENTIAL_CLIENT_ID,
      clientName: `${CONFIDENTIAL_CLIENT_ID} の表示名`,
      scopes: ["openid", "profile", "email"],
    });
    expect(result.value[0]?.grantedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("内部 ID を外へ出さない", async () => {
    // `oauth_clients.id`（`cli_...`）がダッシュボードの HTML に載ると、
    // 以後それを受け付ける API を消せなくなる。
    await completeCodeFlow();
    const result = await rpc.listGrants({ sessionToken: user.sessionToken });

    expect(JSON.stringify(result)).not.toContain(firstParty.id);
  });

  it("同意していないアプリは出てこない", async () => {
    await completeCodeFlow();
    const result = await rpc.listGrants({ sessionToken: user.sessionToken });

    expect(result.ok && result.value.map((g) => g.clientId)).toEqual([CONFIDENTIAL_CLIENT_ID]);
  });

  it("取り消し済みの同意は一覧に出さない", async () => {
    // UI 上で「取り消す」対象にできないものを並べると、
    // 「取り消したのにまだ残っている」と読めてしまう。
    await completeCodeFlow();
    await rpc.revokeGrant({ sessionToken: user.sessionToken, clientId: CONFIDENTIAL_CLIENT_ID });

    const result = await rpc.listGrants({ sessionToken: user.sessionToken });

    expect(result.ok && result.value).toEqual([]);
  });

  it("失効させたクライアントの同意は残す", async () => {
    // 利用者から見れば「許可した覚えのあるアプリ」であることに変わりはなく、
    // 一覧から消すと取り消す手段ごと消える。
    await completeCodeFlow();
    await db()
      .update(oauthClients)
      .set({ disabledAt: new Date() })
      .where(eq(oauthClients.id, firstParty.id))
      .run();

    const result = await rpc.listGrants({ sessionToken: user.sessionToken });

    expect(result.ok && result.value).toHaveLength(1);
  });

  it("他人の同意は見えない", async () => {
    // userId を引数に取らない設計（仕様書 4.2）の帰結。
    await completeCodeFlow();
    const other = await seedLoggedInUser();

    const result = await rpc.listGrants({ sessionToken: other.sessionToken });

    expect(result.ok && result.value).toEqual([]);
  });

  it("セッションが無効なら unauthenticated", async () => {
    const result = await rpc.listGrants({ sessionToken: "x".repeat(40) });

    expect(result).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  });

  it("スキーマ違反の DTO は invalid_input", async () => {
    // Binding を持つ Worker が侵害された場合を想定し、内部 RPC でも
    // 必ず入力検証を行う（仕様書 9 補足）。
    const result = await rpc.listGrants({ sessionToken: "short" } as never);

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("revokeGrant", () => {
  it("同意を取り消し、トークンを失効させる", async () => {
    await completeCodeFlow();

    const result = await rpc.revokeGrant({
      sessionToken: user.sessionToken,
      clientId: CONFIDENTIAL_CLIENT_ID,
    });

    expect(result).toMatchObject({ ok: true, value: { revoked: true, revokedTokenCount: 1 } });
  });

  it("取り消した後、そのトークンで userinfo が 401 になる", async () => {
    // 受け入れ条件の本体。取り消したのにトークンが生き続けるのは
    // 利用者の期待に反する。
    const accessToken = await completeCodeFlow();
    expect((await userinfoRequest(accessToken)).status).toBe(200);

    await rpc.revokeGrant({ sessionToken: user.sessionToken, clientId: CONFIDENTIAL_CLIENT_ID });

    expect((await userinfoRequest(accessToken)).status).toBe(401);
  });

  it("未交換の認可コードも失効させる", async () => {
    // 取り消した直後にコードがトークンへ化けると、取り消しの意味が欠ける。
    const pkce = await createPkcePair();
    await completeCodeFlow();
    const authorized = await authorize(authorizeQuery({ code_challenge: pkce.challenge }), {
      cookie: sessionCookie(user),
      env: appEnv(signingKey),
    });
    const code = locationParams(authorized).get("code");

    await rpc.revokeGrant({ sessionToken: user.sessionToken, clientId: CONFIDENTIAL_CLIENT_ID });

    const exchanged = await tokenRequest(
      {
        grant_type: "authorization_code",
        client_id: CONFIDENTIAL_CLIENT_ID,
        client_secret: CONFIDENTIAL_SECRET,
        redirect_uri: REDIRECT_URI,
        code: code ?? "",
        code_verifier: pkce.verifier,
      },
      { env: appEnv(signingKey) },
    );

    expect(exchanged.status).toBe(400);

    // 失効は `expires_at` の引き戻しで表現され、`consumed_at` は触らない
    // （`AuthorizationCodeRepository.revokeUnconsumedByUser` のコメント）。
    // 交換済みの行は対象外なので、未交換の行だけを見る。
    const unconsumed = (await db().select().from(oauthAuthorizationCodes).all()).filter(
      (row) => row.consumedAt === null,
    );
    expect(unconsumed).not.toHaveLength(0);
    expect(unconsumed.every((row) => row.expiresAt.getTime() <= Date.now())).toBe(true);
  });

  it("別のアプリのトークンは巻き込まない", async () => {
    const mine = await completeCodeFlow("confidential");
    const other = await completeCodeFlow("public");

    await rpc.revokeGrant({ sessionToken: user.sessionToken, clientId: CONFIDENTIAL_CLIENT_ID });

    expect((await userinfoRequest(mine)).status).toBe(401);
    expect((await userinfoRequest(other)).status).toBe(200);
  });

  it("2 回目は revoked: false（冪等）", async () => {
    await completeCodeFlow();
    await rpc.revokeGrant({ sessionToken: user.sessionToken, clientId: CONFIDENTIAL_CLIENT_ID });

    const second = await rpc.revokeGrant({
      sessionToken: user.sessionToken,
      clientId: CONFIDENTIAL_CLIENT_ID,
    });

    expect(second).toMatchObject({ ok: true, value: { revoked: false } });
  });

  it("取り消し済みでも残っているトークンは掃除する", async () => {
    // 片方だけ成功した中断から呼び直したとき、再実行で状態が収束する。
    await completeCodeFlow();
    await db()
      .update(oauthGrants)
      .set({ revokedAt: new Date() })
      .where(eq(oauthGrants.userId, user.userId))
      .run();

    const result = await rpc.revokeGrant({
      sessionToken: user.sessionToken,
      clientId: CONFIDENTIAL_CLIENT_ID,
    });

    expect(result).toMatchObject({ ok: true, value: { revoked: false, revokedTokenCount: 1 } });
    const rows = await db().select().from(oauthTokens).all();
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("他人の同意は取り消せない", async () => {
    await completeCodeFlow();
    const other = await seedLoggedInUser();

    const result = await rpc.revokeGrant({
      sessionToken: other.sessionToken,
      clientId: CONFIDENTIAL_CLIENT_ID,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
    // 他人の同意もトークンも無事であること。
    const rows = await db().select().from(oauthTokens).all();
    expect(rows.every((row) => row.revokedAt === null)).toBe(true);
  });

  it("未知の client_id と、同意していない client_id を区別しない", async () => {
    // 区別すると、どの client_id が登録済みかを総当たりで調べる窓口になる。
    await seedClient({
      clientId: "registered-but-not-consented",
      clientType: "public",
      isFirstParty: false,
    });

    const unknown = await rpc.revokeGrant({
      sessionToken: user.sessionToken,
      clientId: "never-registered",
    });
    const notConsented = await rpc.revokeGrant({
      sessionToken: user.sessionToken,
      clientId: "registered-but-not-consented",
    });

    expect(unknown).toEqual(notConsented);
  });

  it("セッションが無効なら unauthenticated", async () => {
    const result = await rpc.revokeGrant({
      sessionToken: "x".repeat(40),
      clientId: CONFIDENTIAL_CLIENT_ID,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  });

  it("スキーマ違反の DTO は invalid_input", async () => {
    const result = await rpc.revokeGrant({
      sessionToken: user.sessionToken,
      clientId: "",
    } as never);

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("失効させたクライアントの同意も取り消せる", async () => {
    // 運営がクライアントを止めた後でも、利用者は自分の同意を片付けられる。
    await completeCodeFlow();
    await db()
      .update(oauthClients)
      .set({ disabledAt: new Date() })
      .where(eq(oauthClients.id, firstParty.id))
      .run();

    const result = await rpc.revokeGrant({
      sessionToken: user.sessionToken,
      clientId: CONFIDENTIAL_CLIENT_ID,
    });

    expect(result).toMatchObject({ ok: true, value: { revoked: true } });
  });
});

describe("ping（#44）", () => {
  it("認証なしで ok を返す", async () => {
    // dashboard-worker の /health は認証されていない要求から呼ばれる。
    const result = await rpc.ping();

    expect(result).toEqual({ ok: true, value: { status: "ok", service: "u18-auth" } });
  });

  it("識別子を 1 つも返さない", async () => {
    // 載せた瞬間、認証なしで読める情報が増える。
    await completeCodeFlow();
    const dumped = JSON.stringify(await rpc.ping());

    expect(dumped).not.toContain(user.userId);
    expect(dumped).not.toContain(user.email);
    expect(dumped).not.toContain(user.sessionToken);
  });

  it("副作用が無い（何度呼んでも同じ）", async () => {
    const first = await rpc.ping();
    const second = await rpc.ping();

    expect(second).toEqual(first);
  });
});

describe("セッショントークンやメールアドレスを DTO に載せない", () => {
  it("listGrants の応答に含まれない", async () => {
    await completeCodeFlow();
    const dumped = JSON.stringify(await rpc.listGrants({ sessionToken: user.sessionToken }));

    expect(dumped).not.toContain(user.sessionToken);
    expect(dumped).not.toContain(user.email);
  });
});
