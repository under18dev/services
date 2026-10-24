import { env } from "cloudflare:test";
import {
  createIdentityDatabase,
  emailChallenges,
  oauthAuthorizationCodes,
  oauthTokens,
  webauthnChallenges,
} from "@u18/db";
import { newId } from "@u18/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { DrizzleEmailChallengeRepository } from "../src/infrastructure/persistence/drizzle-email-challenge.repository";
import { DrizzleWebAuthnChallengeRepository } from "../src/infrastructure/persistence/drizzle-webauthn-challenge.repository";
import { resetDatabase } from "./helpers";
import {
  appEnv,
  authorize,
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
  tokenHttpRequest,
  type PkcePair,
  type SeededUser,
  type SigningKey,
} from "./helpers.oauth";

/**
 * 単回消費の競合（#19 / 仕様書 7.3・11.2）。
 *
 * ## このテストが無いと何が証明できないか
 *
 * MVP 受け入れ基準の「認可コードを再利用できない」は、**同じ要求を 2 回
 * 順番に投げるテストでは証明にならない**。1 回目が完了した後に 2 回目を
 * 投げるだけなら、`SELECT` → 判定 → `UPDATE` に分かれた実装でも通ってしまう。
 * 壊れるのは「2 本が同時に SELECT し、どちらも未使用だと判断する」場合だけで、
 * それを再現するには並行実行が要る。
 *
 * ## in-memory のフェイクで代替しない
 *
 * `InMemoryAuthorizationCodeRepository` は単一スレッドの Map なので、
 * 「同時に 2 本」という状況そのものを作れない。ここは実 D1（miniflare の
 * SQLite、本番と同じ実装）に対して走らせる。
 *
 * ## この検証が意味を持つことの確認
 *
 * `drizzle-authorization-code.repository.ts` の `consume()` を
 * `SELECT` → 判定 → `UPDATE` の 2 文へ書き換えると、下の
 * 「成功はちょうど 1 件」が実際に落ちる（#19 受け入れ条件の 4 つ目）。
 * 確認済みで、結果は PR の記述に残してある。
 */

const PARALLEL = 10;

let user: SeededUser;
let pkce: PkcePair;
let signingKey: SigningKey;

beforeEach(async () => {
  await resetDatabase();
  await seedDefaultClients();
  user = await seedLoggedInUser();
  pkce = await createPkcePair();
  signingKey = await seedSigningKey();
});

async function obtainCode(): Promise<string> {
  const response = await authorize(authorizeQuery({ code_challenge: pkce.challenge }), {
    cookie: sessionCookie(user),
    env: appEnv(signingKey),
  });
  const code = locationParams(response).get("code");
  if (code === null) throw new Error("コードが得られなかった");
  return code;
}

/** 同じコードに対する交換要求を N 本、同時に投げる。 */
function exchangeInParallel(code: string, count: number): Promise<Response[]> {
  const workerEnv = appEnv(signingKey);
  return Promise.all(
    Array.from({ length: count }, () =>
      fetchApp(
        tokenHttpRequest({
          grant_type: "authorization_code",
          client_id: CONFIDENTIAL_CLIENT_ID,
          client_secret: CONFIDENTIAL_SECRET,
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: pkce.verifier,
        }),
        workerEnv,
      ),
    ),
  );
}

describe("認可コードの同時交換", () => {
  it(`${PARALLEL} 並列でも成功はちょうど 1 件`, async () => {
    const code = await obtainCode();
    const responses = await exchangeInParallel(code, PARALLEL);

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(PARALLEL - 1);
  });

  it("失敗した側はトークンを 1 つも受け取らない", async () => {
    const code = await obtainCode();
    const responses = await exchangeInParallel(code, PARALLEL);

    const bodies = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      })),
    );

    for (const { status, body } of bodies) {
      if (status === 200) {
        expect(body["access_token"]).toBeTruthy();
        expect(body["id_token"]).toBeTruthy();
      } else {
        // `invalid_grant` 以外は返らない。理由を呼び分けると、攻撃者は
        // 1 回の要求ごとに「何が合っていたか」を 1 ビット確かめられる。
        expect(body).toMatchObject({ error: "invalid_grant" });
        expect("access_token" in body).toBe(false);
        expect("id_token" in body).toBe(false);
      }
    }
  });

  it("トークンが 2 セット発行されない", async () => {
    const code = await obtainCode();
    await exchangeInParallel(code, PARALLEL);

    // 成功は 1 回なので行も 1 件。失効済みの行が増えていても困るので
    // 「失効していない 1 件」ではなく「全部で 1 件」を見る。
    const rows = await db().select().from(oauthTokens).all();
    expect(rows).toHaveLength(1);
  });

  it("consumed_at が 1 度しか書かれない", async () => {
    const code = await obtainCode();
    await exchangeInParallel(code, PARALLEL);

    const row = await db().select().from(oauthAuthorizationCodes).get();
    expect(row?.consumedAt).not.toBeNull();

    // 2 本目以降が `consumed_at` を上書きしていたら、リプレイ検出の
    // 「いつ最初に使われたか」が失われる。UPDATE の WHERE 句に
    // `consumed_at IS NULL` が入っていることの裏返し。
    const consumedAt = row!.consumedAt!.getTime();
    expect(consumedAt).toBeGreaterThanOrEqual(row!.createdAt.getTime());
    expect(consumedAt).toBeLessThan(row!.expiresAt.getTime());
  });

  it("期限切れ寸前のコードでも、成功は 1 件か 0 件に収まる", async () => {
    const code = await obtainCode();
    // 残り数ミリ秒。要求の処理中に期限を跨ぐので、全滅もありうる。
    await db()
      .update(oauthAuthorizationCodes)
      .set({ expiresAt: new Date(Date.now() + 5) })
      .run();

    const responses = await exchangeInParallel(code, PARALLEL);
    const succeeded = responses.filter((response) => response.status === 200);

    // 「2 件以上成功する」ことが無いのが本題。0 件は期限切れとして正常。
    expect(succeeded.length).toBeLessThanOrEqual(1);
    expect(await db().select().from(oauthTokens).all()).toHaveLength(succeeded.length);
  });
});

/**
 * 同じ形の保証を OTP と WebAuthn Challenge にも掛ける（#19）。
 *
 * どちらも「単回使用」を `consumed_at` への条件付き UPDATE で表現している。
 * 認可コードだけテストして他を放置すると、同じ種類の穴が残る。
 */
describe("メール OTP の同時検証", () => {
  const CODE = "123456";
  const EMAIL = "otp-race@example.com";

  it("同じコードを 10 並列で消費しても成功は 1 件", async () => {
    const repository = new DrizzleEmailChallengeRepository(createIdentityDatabase(env.IDENTITY_DB));
    const hasher = new Sha256TokenHasher();
    const codeHash = await hasher.hash(CODE);

    await repository.create({
      id: newId("emc"),
      userId: null,
      email: EMAIL,
      codeHash,
      purpose: "login",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      maxAttempts: 5,
      sentAt: new Date(),
    });

    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        repository.consume(EMAIL, "login", codeHash, new Date()),
      ),
    );

    expect(results.filter((result) => result.outcome === "consumed")).toHaveLength(1);

    const row = await createIdentityDatabase(env.IDENTITY_DB).select().from(emailChallenges).get();
    expect(row?.consumedAt).not.toBeNull();
  });
});

describe("WebAuthn Challenge の同時消費", () => {
  it("同じ Challenge を 10 並列で消費しても成功は 1 件", async () => {
    const database = createIdentityDatabase(env.IDENTITY_DB);
    const repository = new DrizzleWebAuthnChallengeRepository(database);
    const id = newId("wac");

    await repository.create({
      id,
      userId: null,
      challenge: "challenge-value",
      purpose: "authentication",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => repository.consume(id, new Date())),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await database.select().from(webauthnChallenges).get())?.consumedAt).not.toBeNull();
  });
});
