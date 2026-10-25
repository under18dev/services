import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { createIdentityDatabase, signingKeyMetadata } from "@u18/db";
import { exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { resetDatabase } from "./helpers";

async function health(overrides: Record<string, unknown> = {}): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  // SELF.fetch は vitest.config.ts の固定 env を使うので、Secret を
  // 差し替えられない。createApp() を直接叩いて env を渡す。
  const ctx = createExecutionContext();
  const response = await createApp().fetch(
    new Request("http://localhost/health"),
    { ...env, ...overrides } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("GET /health", () => {
  it("D1 に到達できるとき 200 と ok を返す", async () => {
    const response = await SELF.fetch("http://localhost/health");

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["service"]).toBe("u18-auth");
    expect(body["checks"]).toMatchObject({ database: "ok" });
  });
});

/**
 * 署名鍵の整合を外形から見えるようにする（#23 の残存リスク）。
 *
 * `signing_key_metadata` と `SIGNING_KEY_JWK` が食い違っても誰も気づかない、
 * というのが docs/runbook.md 4.1 制約 3 で、埋める手段が
 * 「運用者が `signing-key.mjs verify` を実行する」しか無かった。
 */
describe("GET /health の checks.signingKey", () => {
  afterEach(async () => {
    await resetDatabase();
  });

  async function seedActiveKey(): Promise<string> {
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const kid = "u18-health-1";
    const meta = { alg: "ES256", use: "sig", kid };
    const publicJwk = { ...(await exportJWK(publicKey)), ...meta };
    const privateJwk = { ...(await exportJWK(privateKey)), ...meta };

    await createIdentityDatabase(env.IDENTITY_DB)
      .insert(signingKeyMetadata)
      .values({
        kid,
        algorithm: "ES256",
        publicJwk: JSON.stringify(publicJwk),
        activeFrom: new Date(Date.now() - 60_000),
      })
      .run();

    return JSON.stringify({ keys: [privateJwk] });
  }

  it("構成を外へ出さない（RR-18）", async () => {
    // `/health` は未認証で叩ける唯一の D1 クエリ経路。環境名と issuer を
    // 返していると、ステージングの存在や構成が外から読める。
    //
    // **`--env production` の付け忘れの検知は Discovery の issuer へ移した**
    // （.github/workflows/deploy.yml）。ここを戻すならあちらも戻すこと。
    const { body } = await health();

    expect(Object.keys(body).sort()).toEqual(
      ["checks", "latencyMs", "service", "status", "time"].sort(),
    );
    expect(JSON.stringify(body)).not.toContain("localhost:8787");
  });

  it("鍵が揃っていれば ok", async () => {
    const secret = await seedActiveKey();

    const { status, body } = await health({ SIGNING_KEY_JWK: secret });

    expect(status).toBe(200);
    expect(body["checks"]).toEqual({ database: "ok", signingKey: "ok" });
  });

  it("署名鍵が未設定でも 200 のまま unavailable を返す", async () => {
    // **ここが #23 の担当が /health を避けた理由への回答。** 鍵を一度も
    // 設定していない環境（Phase 1 相当・プレビュー）でも Worker は生きていて
    // OIDC 以外は全部動く。赤くするのは死活監視として正しくない。
    const { status, body } = await health({
      SIGNING_KEY_JWK: undefined,
      SIGNING_KEY_KID: undefined,
    });

    expect(status).toBe(200);
    expect(body["status"]).toBe("ok");
    expect(body["checks"]).toEqual({ database: "ok", signingKey: "unavailable" });
  });

  it("kid を応答に出さない", async () => {
    const secret = await seedActiveKey();

    const { body } = await health({ SIGNING_KEY_JWK: secret });

    // 未認証で叩ける endpoint から鍵の識別子が見えて得られるものが無い。
    expect(JSON.stringify(body)).not.toContain("u18-health-1");
  });
});

describe("未定義のエンドポイント", () => {
  it("404 を返す", async () => {
    const response = await SELF.fetch("http://localhost/does-not-exist");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });
});

describe("Phase 2 の OIDC エンドポイントは全て実装済み", () => {
  // 実装の中身はそれぞれの専用ファイルにある:
  //   JWKS（#14） → jwks.test.ts
  //   /oauth/authorize（#15） → oauth-authorize.test.ts
  //   /oauth/token（#16） → oauth-token.test.ts
  //   /oauth/userinfo・/oauth/revoke（#17） → oauth-userinfo.test.ts, oauth-revoke.test.ts
  //
  // ここに残してあるのは「ルートが登録されていること」だけを見る哨戒線。
  // 401 や 400 を返すのは認証情報を付けていないためで、正常である。
  // 501 / 404 に戻ったらルートの配線が外れたことを意味する。
  it.each([
    ["/oauth/userinfo", "GET"],
    ["/oauth/userinfo", "POST"],
    ["/oauth/revoke", "POST"],
  ])("%s (%s) は 501 でも 404 でもない", async (path, method) => {
    const response = await SELF.fetch(`http://localhost${path}`, { method });

    expect(response.status).not.toBe(501);
    expect(response.status).not.toBe(404);
  });
});
