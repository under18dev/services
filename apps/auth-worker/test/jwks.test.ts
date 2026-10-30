import { SELF, env } from "cloudflare:test";
import { createIdentityDatabase, signingKeyMetadata } from "@u18/db";
import { createLocalJWKSet, exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./helpers";

/**
 * `GET /.well-known/jwks.json`（#14 / 仕様書 5.2・5.4）。
 *
 * ここで守りたいのは 2 つ。
 *
 * 1. **秘密鍵が外へ出ないこと。** JWKS は u18 で唯一「鍵の素材を意図的に公開する」
 *    エンドポイントなので、`d` が 1 度でも載れば全 ID Token を偽造されうる。
 *    公開鍵と秘密鍵の取り違えは運用で起こりうるので、実装側で止まることを
 *    テストで固定する。
 *
 *    **脅威モデルの番号は引かない**（#371）。この漏洩経路（JWKS が秘密鍵
 *    そのものを誤って配る）を単独で立てた脅威 ID が無い——一番近い S-4
 *    （ID Token の偽造 / アルゴリズム混同）は `alg: "none"` と HS256 混同の
 *    話で、経路が違う。最も近いのは資産表の A1（ID Token 署名秘密鍵）だが、
 *    `A` 接頭辞は `worker-configuration.d.ts` のような生成物で頻出する
 *    文字列（型名の断片など）と衝突しやすく、`check-threat-model-refs.mjs`
 *    の対象には入れていない。番号を書くより、理由をそのまま書いたほうが
 *    正確である。
 * 2. **ローテーション中の旧鍵が消えないこと。** `active_until` を過ぎた鍵を
 *    JWKS から即座に外すと、その鍵で署名済みの発行済みトークンが一斉に
 *    検証失敗する（docs/runbook.md 4.2 ステップ 5・7）。
 */

const DAY = 24 * 60 * 60 * 1000;

type Jwk = Record<string, unknown>;

async function generateSigningKey(kid: string): Promise<{
  readonly kid: string;
  readonly privateJwk: Jwk;
  readonly publicJwk: Jwk;
}> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const meta = { alg: "ES256", use: "sig", kid };
  return {
    kid,
    privateJwk: { ...(await exportJWK(privateKey)), ...meta },
    publicJwk: { ...(await exportJWK(publicKey)), ...meta },
  };
}

async function seedKey(row: {
  readonly kid: string;
  readonly publicJwk: Jwk | string;
  readonly algorithm?: string;
  readonly activeFrom?: Date;
  readonly activeUntil?: Date | null;
  readonly retiresAt?: Date | null;
}): Promise<void> {
  const now = Date.now();
  await createIdentityDatabase(env.IDENTITY_DB)
    .insert(signingKeyMetadata)
    .values({
      kid: row.kid,
      algorithm: row.algorithm ?? "ES256",
      publicJwk: typeof row.publicJwk === "string" ? row.publicJwk : JSON.stringify(row.publicJwk),
      activeFrom: row.activeFrom ?? new Date(now - DAY),
      activeUntil: row.activeUntil ?? null,
      retiresAt: row.retiresAt ?? null,
    })
    .run();
}

async function fetchJwks(): Promise<Response> {
  return SELF.fetch("http://localhost/.well-known/jwks.json");
}

describe("GET /.well-known/jwks.json", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("登録済みの公開鍵を JWK Set として返す", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    await seedKey({ kid: key.kid, publicJwk: key.publicJwk });

    const response = await fetchJwks();
    expect(response.status).toBe(200);

    const body = (await response.json()) as { keys: Jwk[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toEqual({
      kid: key.kid,
      kty: "EC",
      crv: "P-256",
      x: key.publicJwk["x"],
      y: key.publicJwk["y"],
      alg: "ES256",
      use: "sig",
    });
  });

  it("秘密鍵成分 d を応答に含めない", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    // 運用者が docs/runbook.md 2.4.1 の 3 つの出力を取り違え、
    // public_jwk 列へ秘密鍵の JWK を入れてしまった状況を再現する。
    await seedKey({ kid: key.kid, publicJwk: key.privateJwk });

    const response = await fetchJwks();
    const raw = await response.text();

    // 応答そのものを文字列で見る。構造化してから確認すると、
    // 「JSON に d が無い」ことしか言えない。
    expect(raw).not.toContain(key.privateJwk["d"]);
    expect(raw).not.toContain('"d"');

    const body = JSON.parse(raw) as { keys: Jwk[] };
    expect(Object.keys(body.keys[0]!)).not.toContain("d");
    // 公開鍵としては正しく出ている（壊して回避したわけではない）。
    expect(body.keys[0]?.["x"]).toBe(key.publicJwk["x"]);
  });

  it("retires_at 前の鍵はすべて返す（新規署名に使わない鍵も含む）", async () => {
    const now = Date.now();
    const current = await generateSigningKey("current");
    const rotatingOut = await generateSigningKey("rotating-out");
    const incoming = await generateSigningKey("incoming");
    const retired = await generateSigningKey("retired");

    await seedKey({ kid: current.kid, publicJwk: current.publicJwk });
    // 新規署名は停止済み。ただし発行済みトークンの検証のためまだ配る。
    await seedKey({
      kid: rotatingOut.kid,
      publicJwk: rotatingOut.publicJwk,
      activeUntil: new Date(now - 60_000),
      retiresAt: new Date(now + 7 * DAY),
    });
    // 先行公開中（runbook 4.2 ステップ 2）。まだ署名には使わないが JWKS には出す。
    await seedKey({
      kid: incoming.kid,
      publicJwk: incoming.publicJwk,
      activeFrom: new Date(now + DAY),
    });
    // 撤去時刻を過ぎた鍵だけが消える。
    await seedKey({
      kid: retired.kid,
      publicJwk: retired.publicJwk,
      activeUntil: new Date(now - 30 * DAY),
      retiresAt: new Date(now - DAY),
    });

    const body = (await (await fetchJwks()).json()) as { keys: Jwk[] };
    expect(body.keys.map((k) => k["kid"]).sort()).toEqual(["current", "incoming", "rotating-out"]);
  });

  it("キャッシュ可能だが、鍵の緊急失効が伝わる長さに抑える", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    await seedKey({ kid: key.kid, publicJwk: key.publicJwk });

    const response = await fetchJwks();
    // 長くすると、失効させた鍵を信じ続ける RP が増える（runbook 5.1）。
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("鍵が 1 つも無いときは 200 で空集合を返さない", async () => {
    const response = await fetchJwks();

    // 空の JWKS を 200 で返すと、RP はそれを正常な応答としてキャッシュし、
    // 鍵を入れ直しても TTL の間は「鍵が無い」状態を信じ続ける。
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "jwks_unavailable" });
  });

  it("Discovery の jwks_uri を辿って取得した鍵で ID Token を検証できる", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    await seedKey({ kid: key.kid, publicJwk: key.publicJwk });

    const discovery = (await (
      await SELF.fetch("http://localhost/.well-known/openid-configuration")
    ).json()) as Record<string, string>;

    // 広告している URI をそのまま辿る。Discovery と実装がずれていれば
    // ここで 404 になる（issuer は wrangler.jsonc の ISSUER 由来なので、
    // 本番ドメイン #33 に差し替わっても同じ対応関係が保たれる）。
    const jwksPath = new URL(discovery["jwks_uri"]!).pathname;
    expect(jwksPath).toBe("/.well-known/jwks.json");
    const jwks = (await (await SELF.fetch(`http://localhost${jwksPath}`)).json()) as {
      keys: Jwk[];
    };

    // 署名側は Workers Secret にある秘密鍵（テストではローカルで生成した方）。
    const token = await new SignJWT({ sub: "usr_test", aud: "u18-dashboard" })
      .setProtectedHeader({ alg: "ES256", kid: key.kid })
      .setIssuer(discovery["issuer"]!)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(await importPrivateKey(key.privateJwk));

    // 検証側は JWKS から取った公開鍵だけを使う。RP がやることと同じ手順。
    const keyStore = createLocalJWKSet(jwks);
    const { payload, protectedHeader } = await jwtVerify(token, keyStore, {
      issuer: discovery["issuer"]!,
      algorithms: ["ES256"],
    });

    expect(protectedHeader.kid).toBe(key.kid);
    expect(payload["sub"]).toBe("usr_test");
  });
});

async function importPrivateKey(jwk: Jwk): Promise<CryptoKey> {
  const key = await importJWK(jwk as Parameters<typeof importJWK>[0], "ES256");
  if (!(key instanceof CryptoKey)) throw new Error("expected an EC private key");
  return key;
}
