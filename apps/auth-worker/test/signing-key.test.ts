import { env } from "cloudflare:test";
import { createIdentityDatabase, signingKeyMetadata } from "@u18/db";
import { FixedClock } from "@u18/domain";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import type { SigningKeyMetadata } from "../src/application/ports/signing-key.port";
import { JoseSigningKeyProvider } from "../src/infrastructure/crypto/jose-signing-key";
import { DrizzleSigningKeyMetadataRepository } from "../src/infrastructure/persistence/drizzle-signing-key-metadata.repository";
import { InMemorySigningKeyMetadataRepository } from "./fakes.oauth";
import { resetDatabase } from "./helpers";

const NOW = new Date("2026-10-24T00:00:00.000Z");
const clock = new FixedClock(NOW);
const DAY = 24 * 60 * 60 * 1000;

/**
 * ES256 の鍵ペアを 1 組作る。
 *
 * 鍵をテストへハードコードしない。リポジトリに秘密鍵を置くと、開発用であっても
 * 「どこかで本番に流用される」経路ができる（docs/runbook.md 2.4.1）。
 */
async function generateSigningKey(kid: string): Promise<{
  readonly kid: string;
  /** Workers Secret に入る側（`d` を含む）。 */
  readonly privateJwk: Record<string, unknown>;
  /** `signing_key_metadata.public_jwk` に入る側。 */
  readonly publicJwk: Record<string, unknown>;
}> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const meta = { alg: "ES256", use: "sig", kid };
  return {
    kid,
    privateJwk: { ...(await exportJWK(privateKey)), ...meta },
    publicJwk: { ...(await exportJWK(publicKey)), ...meta },
  };
}

function aRow(overrides: Partial<SigningKeyMetadata> & { kid: string }): SigningKeyMetadata {
  return {
    algorithm: "ES256",
    publicJwk: "{}",
    activeFrom: new Date(NOW.getTime() - DAY),
    activeUntil: null,
    retiresAt: null,
    ...overrides,
  };
}

describe("JoseSigningKeyProvider — 署名鍵の選択", () => {
  it("Secret の kid に対応する行が現役なら、その鍵 1 つに決まる", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    const metadata = new InMemorySigningKeyMetadataRepository();
    // 旧鍵（新規署名は停止済みだが、まだ JWKS には出る）も混ぜておく。
    metadata.seed(aRow({ kid: "u18-2026-07-01-1", activeUntil: new Date(NOW.getTime() - DAY) }));
    metadata.seed(aRow({ kid: key.kid, publicJwk: JSON.stringify(key.publicJwk) }));
    // まだ使ってはいけない先行公開の鍵（runbook 4.2 ステップ 2）。
    metadata.seed(aRow({ kid: "u18-2026-11-01-1", activeFrom: new Date(NOW.getTime() + DAY) }));

    const provider = new JoseSigningKeyProvider(
      metadata,
      clock,
      { jwk: JSON.stringify(key.privateJwk), kid: key.kid },
      "unused",
    );

    const active = await provider.getActiveSigningKey();
    expect(active.kid).toBe(key.kid);
    expect(active.alg).toBe("ES256");
    expect(active.privateKey.type).toBe("private");
  });

  it("署名した JWT が JWKS 側の公開鍵で検証できる", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    const metadata = new InMemorySigningKeyMetadataRepository();
    metadata.seed(aRow({ kid: key.kid, publicJwk: JSON.stringify(key.publicJwk) }));
    const provider = new JoseSigningKeyProvider(
      metadata,
      clock,
      { jwk: JSON.stringify(key.privateJwk), kid: key.kid },
      "unused",
    );

    const active = await provider.getActiveSigningKey();
    const token = await new SignJWT({ sub: "usr_test" })
      .setProtectedHeader({ alg: "ES256", kid: active.kid })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(active.privateKey);

    // JWKS に出した公開鍵だけで検証できること。ここが崩れると、
    // 配っている公開鍵と署名鍵が別物ということになる（runbook 4.1 制約 3）。
    const [published] = await provider.getPublicJwks();
    const { payload } = await jwtVerify(token, published!, { algorithms: ["ES256"] });
    expect(payload["sub"]).toBe("usr_test");
  });

  it("Secret が未設定なら、組み立て時ではなく署名時に失敗する", async () => {
    const metadata = new InMemorySigningKeyMetadataRepository();
    metadata.seed(aRow({ kid: "u18-2026-10-24-1" }));
    const provider = new JoseSigningKeyProvider(metadata, clock, null, "secret is missing");

    await expect(provider.getActiveSigningKey()).rejects.toThrow(/not configured/);
  });

  it("kid が signing_key_metadata に無ければ署名しない", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    const metadata = new InMemorySigningKeyMetadataRepository();
    metadata.seed(aRow({ kid: "u18-2026-07-01-1" }));

    const provider = new JoseSigningKeyProvider(
      metadata,
      clock,
      { jwk: JSON.stringify(key.privateJwk), kid: key.kid },
      "unused",
    );

    // JWKS に載らない kid を名乗る ID Token は、全 RP で検証に失敗する。
    // 配ってから気付くより、発行を止めるほうがよい。
    await expect(provider.getActiveSigningKey()).rejects.toThrow(/no row in signing_key_metadata/);
  });

  it.each([
    ["active_until を過ぎている", { activeUntil: new Date(NOW.getTime() - 1) }],
    ["active_from がまだ来ていない", { activeFrom: new Date(NOW.getTime() + DAY) }],
  ])("kid の行が %s なら署名しない", async (_label, overrides) => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    const metadata = new InMemorySigningKeyMetadataRepository();
    metadata.seed(aRow({ kid: key.kid, ...overrides }));

    const provider = new JoseSigningKeyProvider(
      metadata,
      clock,
      { jwk: JSON.stringify(key.privateJwk), kid: key.kid },
      "unused",
    );

    await expect(provider.getActiveSigningKey()).rejects.toThrow(/is not active/);
  });

  it("SIGNING_KEY_JWK に公開鍵を入れていたら署名前に気付ける", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    const metadata = new InMemorySigningKeyMetadataRepository();
    metadata.seed(aRow({ kid: key.kid, publicJwk: JSON.stringify(key.publicJwk) }));

    // runbook 2.4.1 が警告している 3 つの出力の取り違え。
    const provider = new JoseSigningKeyProvider(
      metadata,
      clock,
      { jwk: JSON.stringify(key.publicJwk), kid: key.kid },
      "unused",
    );

    await expect(provider.getActiveSigningKey()).rejects.toThrow(/no private component/);
  });

  it("秘密鍵が無くても JWKS は応答できる", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    const metadata = new InMemorySigningKeyMetadataRepository();
    metadata.seed(aRow({ kid: key.kid, publicJwk: JSON.stringify(key.publicJwk) }));

    // 秘密鍵の設定漏れで公開鍵の配布まで止めない（container.ts の分離）。
    const provider = new JoseSigningKeyProvider(metadata, clock, null, "secret is missing");

    const keys = await provider.getPublicJwks();
    expect(keys.map((k) => k.kid)).toEqual([key.kid]);
  });
});

describe("JoseSigningKeyProvider — JWKS に出す鍵", () => {
  it("public_jwk に秘密鍵を貼られていても d を外へ出さない", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    const metadata = new InMemorySigningKeyMetadataRepository();
    // 運用者が 2.4.1 の出力を取り違え、秘密鍵の JWK を public_jwk 列に入れた状況。
    metadata.seed(aRow({ kid: key.kid, publicJwk: JSON.stringify(key.privateJwk) }));

    const provider = new JoseSigningKeyProvider(metadata, clock, null, "unused");
    const [published] = await provider.getPublicJwks();

    expect(published).toBeDefined();
    expect(JSON.stringify(published)).not.toContain(key.privateJwk["d"]);
    expect(Object.keys(published!).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x", "y"]);
  });

  it("壊れた行は飛ばし、残りの鍵は配り続ける", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    const metadata = new InMemorySigningKeyMetadataRepository();
    metadata.seed(aRow({ kid: "broken-json", publicJwk: "{" }));
    metadata.seed(aRow({ kid: "wrong-curve", publicJwk: '{"kty":"EC","crv":"P-384"}' }));
    metadata.seed(aRow({ kid: "rsa", algorithm: "RS256", publicJwk: '{"kty":"RSA"}' }));
    metadata.seed(aRow({ kid: key.kid, publicJwk: JSON.stringify(key.publicJwk) }));

    const provider = new JoseSigningKeyProvider(metadata, clock, null, "unused");

    // 1 行壊れただけで JWKS 全体を落とすと、生きている鍵で署名された
    // トークンまで検証できなくなる。
    expect((await provider.getPublicJwks()).map((k) => k.kid)).toEqual([key.kid]);
  });

  it("kid は JWK の中身ではなくテーブルの主キーを正とする", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    const metadata = new InMemorySigningKeyMetadataRepository();
    metadata.seed(
      aRow({ kid: "row-kid", publicJwk: JSON.stringify({ ...key.publicJwk, kid: "jwk-kid" }) }),
    );

    const provider = new JoseSigningKeyProvider(metadata, clock, null, "unused");
    expect((await provider.getPublicJwks())[0]?.kid).toBe("row-kid");
  });
});

describe("DrizzleSigningKeyMetadataRepository", () => {
  let repo: DrizzleSigningKeyMetadataRepository;

  beforeEach(async () => {
    await resetDatabase();
    repo = new DrizzleSigningKeyMetadataRepository(createIdentityDatabase(env.IDENTITY_DB));
  });

  async function seed(row: SigningKeyMetadata): Promise<void> {
    await createIdentityDatabase(env.IDENTITY_DB).insert(signingKeyMetadata).values(row).run();
  }

  it("retires_at を迎えていない鍵をすべて返す", async () => {
    await seed(aRow({ kid: "current" }));
    // 新規署名は止めたが、発行済みトークンの検証のためまだ配る鍵。
    await seed(
      aRow({
        kid: "rotating-out",
        activeUntil: new Date(NOW.getTime() - DAY),
        retiresAt: new Date(NOW.getTime() + 7 * DAY),
      }),
    );
    // 撤去時刻を過ぎた鍵。
    await seed(
      aRow({
        kid: "retired",
        activeUntil: new Date(NOW.getTime() - 30 * DAY),
        retiresAt: new Date(NOW.getTime() - DAY),
      }),
    );

    const rows = await repo.listPublishable(NOW);
    expect(rows.map((row) => row.kid).sort()).toEqual(["current", "rotating-out"]);
  });

  it("findByKid は行をそのまま返す", async () => {
    await seed(aRow({ kid: "current", activeUntil: new Date(NOW.getTime() + DAY) }));

    const row = await repo.findByKid("current");
    expect(row?.algorithm).toBe("ES256");
    expect(row?.activeUntil?.getTime()).toBe(NOW.getTime() + DAY);
    expect(await repo.findByKid("nope")).toBeNull();
  });
});
