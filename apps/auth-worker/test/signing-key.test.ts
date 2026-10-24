import { env } from "cloudflare:test";
import { createIdentityDatabase, signingKeyMetadata } from "@u18/db";
import { FixedClock } from "@u18/domain";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SigningKeyMetadata } from "../src/application/ports/signing-key.port";
import {
  auditSigningKeySecret,
  explainUnusableSigningKeys,
  isMisconfiguration,
  parseSigningKeySecret,
  signingKeyHealth,
} from "../src/domain/services/signing-key-rotation";
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

/**
 * #23 (b): Secret に新旧 2 鍵を同居させられること。
 *
 * ここで確かめたいのは「JWK Set が読める」ことではなく、**鍵の切り替えが
 * Secret ではなく `signing_key_metadata` の UPDATE で起きる**こと。
 * Secret を固定したまま行だけを動かして、署名する kid が変わるかを見る。
 */
describe("JoseSigningKeyProvider — 複数鍵の同居とローテーション", () => {
  /** 2 本を 1 つの JWK Set にまとめた Secret。本番で `wrangler secret put` する値。 */
  function jwkSet(...keys: { readonly privateJwk: Record<string, unknown> }[]): string {
    return JSON.stringify({ keys: keys.map((key) => key.privateJwk) });
  }

  function providerAt(
    metadata: InMemorySigningKeyMetadataRepository,
    secret: string,
    at: Date,
  ): JoseSigningKeyProvider {
    // コンテナはリクエストごとに作られるので、時刻を進めるのは新しい
    // Provider を作ることに等しい。
    return new JoseSigningKeyProvider(
      metadata,
      new FixedClock(at),
      { jwk: secret, kid: null },
      "unused",
    );
  }

  it("先行公開中の新鍵が Secret に入っていても、署名は現役の旧鍵のまま", async () => {
    const [current, next] = await Promise.all([
      generateSigningKey("u18-2026-07-01-1"),
      generateSigningKey("u18-2026-10-24-1"),
    ]);
    const metadata = new InMemorySigningKeyMetadataRepository();
    metadata.seed(aRow({ kid: current.kid, publicJwk: JSON.stringify(current.publicJwk) }));
    // runbook 4.2 ステップ 2 の状態: JWKS には載るが active_from がまだ来ていない。
    metadata.seed(
      aRow({
        kid: next.kid,
        publicJwk: JSON.stringify(next.publicJwk),
        activeFrom: new Date(NOW.getTime() + DAY),
      }),
    );

    const provider = providerAt(metadata, jwkSet(current, next), NOW);

    expect((await provider.getActiveSigningKey()).kid).toBe(current.kid);
    // 両方 JWKS に出ている。これが無いと切り替えた瞬間に RP が新 kid を知らない。
    expect((await provider.getPublicJwks()).map((k) => k.kid).sort()).toEqual(
      [current.kid, next.kid].sort(),
    );
  });

  it("Secret を一切触らずに、DB の更新だけで署名鍵が切り替わる", async () => {
    const [previous, next] = await Promise.all([
      generateSigningKey("u18-2026-07-01-1"),
      generateSigningKey("u18-2026-10-24-1"),
    ]);
    const secret = jwkSet(previous, next);

    const before = new InMemorySigningKeyMetadataRepository();
    before.seed(aRow({ kid: previous.kid, publicJwk: JSON.stringify(previous.publicJwk) }));
    before.seed(
      aRow({
        kid: next.kid,
        publicJwk: JSON.stringify(next.publicJwk),
        activeFrom: new Date(NOW.getTime() + DAY),
      }),
    );
    expect((await providerAt(before, secret, NOW).getActiveSigningKey()).kid).toBe(previous.kid);

    // runbook 4.2 ステップ 4 の UPDATE 2 本だけを当てた状態。
    const after = new InMemorySigningKeyMetadataRepository();
    after.seed(
      aRow({
        kid: previous.kid,
        publicJwk: JSON.stringify(previous.publicJwk),
        activeUntil: NOW,
      }),
    );
    after.seed(aRow({ kid: next.kid, publicJwk: JSON.stringify(next.publicJwk), activeFrom: NOW }));

    expect((await providerAt(after, secret, NOW).getActiveSigningKey()).kid).toBe(next.kid);
  });

  it("切り替え前に出した ID Token が、切り替え後も JWKS の鍵で検証できる", async () => {
    const [previous, next] = await Promise.all([
      generateSigningKey("u18-2026-07-01-1"),
      generateSigningKey("u18-2026-10-24-1"),
    ]);
    const secret = jwkSet(previous, next);

    const metadata = new InMemorySigningKeyMetadataRepository();
    metadata.seed(aRow({ kid: previous.kid, publicJwk: JSON.stringify(previous.publicJwk) }));
    // 新鍵はまだ先行公開の段階（runbook 4.2 ステップ 3 で待っている状態）。
    metadata.seed(
      aRow({
        kid: next.kid,
        publicJwk: JSON.stringify(next.publicJwk),
        activeFrom: new Date(NOW.getTime() + DAY),
      }),
    );

    // 切り替え直前に発行された ID Token。
    const old = await providerAt(metadata, secret, NOW).getActiveSigningKey();
    const issued = await new SignJWT({ sub: "usr_test" })
      .setProtectedHeader({ alg: "ES256", kid: old.kid })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(old.privateKey);

    // 旧鍵は active_until を過ぎたが retires_at はまだ先（= 猶予期間の中）。
    const rotated = new InMemorySigningKeyMetadataRepository();
    rotated.seed(
      aRow({
        kid: previous.kid,
        publicJwk: JSON.stringify(previous.publicJwk),
        activeUntil: NOW,
        retiresAt: new Date(NOW.getTime() + 7 * DAY),
      }),
    );
    rotated.seed(
      aRow({ kid: next.kid, publicJwk: JSON.stringify(next.publicJwk), activeFrom: NOW }),
    );
    const after = providerAt(rotated, secret, new Date(NOW.getTime() + 60_000));

    expect((await after.getActiveSigningKey()).kid).toBe(next.kid);

    // 猶予期間の意味そのもの: 旧 kid のトークンがまだ検証できる。
    const published = await after.getPublicJwks();
    const oldJwk = published.find((key) => key.kid === previous.kid);
    expect(oldJwk).toBeDefined();
    const { payload } = await jwtVerify(issued, oldJwk!, { algorithms: ["ES256"] });
    expect(payload["sub"]).toBe("usr_test");

    // retires_at を過ぎれば JWKS から消える（= 猶予期間の終わり）。
    const later = providerAt(rotated, secret, new Date(NOW.getTime() + 8 * DAY));
    expect((await later.getPublicJwks()).map((k) => k.kid)).toEqual([next.kid]);
  });

  it("現役の鍵が 2 本あったら active_from が新しい方で署名する", async () => {
    const [older, newer] = await Promise.all([
      generateSigningKey("u18-2026-07-01-1"),
      generateSigningKey("u18-2026-10-24-1"),
    ]);
    const metadata = new InMemorySigningKeyMetadataRepository();
    // 旧鍵の active_until を更新し忘れた状態。ここで throw すると、UPDATE が
    // 1 つ遅れただけで認証が全面停止する。
    metadata.seed(
      aRow({
        kid: older.kid,
        publicJwk: JSON.stringify(older.publicJwk),
        activeFrom: new Date(NOW.getTime() - 30 * DAY),
      }),
    );
    metadata.seed(
      aRow({
        kid: newer.kid,
        publicJwk: JSON.stringify(newer.publicJwk),
        activeFrom: new Date(NOW.getTime() - DAY),
      }),
    );

    const provider = providerAt(metadata, jwkSet(older, newer), NOW);
    expect((await provider.getActiveSigningKey()).kid).toBe(newer.kid);
  });

  it("retires_at を過ぎた鍵では署名しない（JWKS に出ていないため）", async () => {
    const key = await generateSigningKey("u18-2026-07-01-1");
    const metadata = new InMemorySigningKeyMetadataRepository();
    // active_until は null のままだが、撤去済みなので JWKS には出ない。
    metadata.seed(
      aRow({
        kid: key.kid,
        publicJwk: JSON.stringify(key.publicJwk),
        retiresAt: new Date(NOW.getTime() - 1),
      }),
    );

    const provider = providerAt(metadata, jwkSet(key), NOW);
    await expect(provider.getActiveSigningKey()).rejects.toThrow(/retires_at has passed/);
  });

  it.each([
    [
      "kid の無い鍵",
      JSON.stringify({ keys: [{ kty: "EC", crv: "P-256", d: "x", x: "x", y: "y" }] }),
      /has no "kid"/,
    ],
    [
      "同じ kid が 2 本",
      JSON.stringify({
        keys: [
          { kty: "EC", crv: "P-256", kid: "dup", d: "x", x: "x", y: "y" },
          { kty: "EC", crv: "P-256", kid: "dup", d: "z", x: "z", y: "w" },
        ],
      }),
      /two keys with kid/,
    ],
    ["空の JWK Set", JSON.stringify({ keys: [] }), /empty JWK Set/],
  ])("壊れた Secret（%s）は 1 本だけ飛ばさず全体を失敗させる", async (_label, secret, expected) => {
    const metadata = new InMemorySigningKeyMetadataRepository();
    metadata.seed(aRow({ kid: "dup" }));

    const provider = providerAt(metadata, secret, NOW);
    await expect(provider.getActiveSigningKey()).rejects.toThrow(expected);
  });
});

/**
 * #23 (c): Secret の中身と `signing_key_metadata` の突き合わせ。
 *
 * kid の存在確認だけでは「同じ名前の別の鍵」を捕まえられない。その状態は
 * auth-worker 側では成功（署名はできる）に見え、症状は全 RP での一斉検証失敗
 * として外側にだけ出る（docs/runbook.md 4.1 制約 3）。
 */
describe("署名鍵の整合検査", () => {
  it("kid は合っているが中身が別の鍵なら署名しない", async () => {
    const [registered, actual] = await Promise.all([
      generateSigningKey("u18-2026-10-24-1"),
      generateSigningKey("u18-2026-10-24-1"),
    ]);
    const metadata = new InMemorySigningKeyMetadataRepository();
    // DB には registered の公開鍵が入っているのに、Secret には別の秘密鍵がある。
    metadata.seed(aRow({ kid: registered.kid, publicJwk: JSON.stringify(registered.publicJwk) }));

    const provider = new JoseSigningKeyProvider(
      metadata,
      clock,
      { jwk: JSON.stringify(actual.privateJwk), kid: actual.kid },
      "unused",
    );

    await expect(provider.getActiveSigningKey()).rejects.toThrow(/does not match public_jwk/);
  });

  it("DB が現役と言っている kid が Secret に無いことを検出する", async () => {
    const [held, missing] = await Promise.all([
      generateSigningKey("u18-2026-07-01-1"),
      generateSigningKey("u18-2026-10-24-1"),
    ]);
    const rows = [
      aRow({ kid: held.kid, publicJwk: JSON.stringify(held.publicJwk) }),
      aRow({ kid: missing.kid, publicJwk: JSON.stringify(missing.publicJwk) }),
    ];

    const parsed = parseSigningKeySecret(JSON.stringify({ keys: [held.privateJwk] }), null);
    expect(parsed.ok).toBe(true);
    const audit = auditSigningKeySecret(parsed.ok ? parsed.keys : [], rows, NOW);

    // Secret を入れ忘れたまま active_from を引き下げた状態がこれ。
    const issue = audit.issues.find((i) => i.problem === "missing-from-secret");
    expect(issue?.kid).toBe(missing.kid);
    expect(isMisconfiguration("missing-from-secret")).toBe(true);
  });

  it("ローテーション中に当然現れる状態は運用ミスと区別される", () => {
    // 先行公開した新鍵と、Secret に残したままの旧鍵。どちらも手順どおり。
    expect(isMisconfiguration("not-yet-active")).toBe(false);
    expect(isMisconfiguration("no-longer-signing")).toBe(false);
    // こちらは手順のどこにも現れない。
    expect(isMisconfiguration("no-row")).toBe(true);
    expect(isMisconfiguration("public-key-mismatch")).toBe(true);
    expect(isMisconfiguration("retired")).toBe(true);
  });

  it("単一 JWK + SIGNING_KEY_KID（#23 以前の形式）がそのまま読める", () => {
    const parsed = parseSigningKeySecret(
      JSON.stringify({ kty: "EC", crv: "P-256", d: "d", x: "x", y: "y" }),
      "legacy-kid",
    );
    expect(parsed.ok && parsed.keys.map((key) => key.kid)).toEqual(["legacy-kid"]);
  });

  it("単一 JWK では SIGNING_KEY_KID が JWK 内の kid より優先される", () => {
    // 既存環境で 2 つが食い違っていた場合に、Secret を触っていないのに
    // 署名する kid が変わってしまうことを避ける。
    const parsed = parseSigningKeySecret(
      JSON.stringify({ kty: "EC", crv: "P-256", kid: "embedded", d: "d", x: "x", y: "y" }),
      "from-env",
    );
    expect(parsed.ok && parsed.keys.map((key) => key.kid)).toEqual(["from-env"]);
  });

  it("JWK Set では SIGNING_KEY_KID を無視する", () => {
    // 消し忘れた 1 行が署名鍵を過去へ巻き戻さないようにするため。
    const parsed = parseSigningKeySecret(
      JSON.stringify({
        keys: [{ kty: "EC", crv: "P-256", kid: "in-set", d: "d", x: "x", y: "y" }],
      }),
      "stale-kid",
    );
    expect(parsed.ok && parsed.keys.map((key) => key.kid)).toEqual(["in-set"]);
  });

  it("どの鍵も使えないときは理由を全部並べる", async () => {
    const [a, b] = await Promise.all([generateSigningKey("key-a"), generateSigningKey("key-b")]);
    const parsed = parseSigningKeySecret(
      JSON.stringify({ keys: [a.privateJwk, b.privateJwk] }),
      null,
    );
    const audit = auditSigningKeySecret(
      parsed.ok ? parsed.keys : [],
      [aRow({ kid: "key-a", activeFrom: new Date(NOW.getTime() + DAY) })],
      NOW,
    );

    expect(audit.signingKid).toBeNull();
    // 1 本ずつ理由が違うので、1 つだけ見せると直し終わらない。
    const message = explainUnusableSigningKeys(audit);
    expect(message).toContain("key-a");
    expect(message).toContain("key-b");
  });
});

/**
 * `/health` の `checks.signingKey`（#23 の残存リスク）。
 *
 * #23 は突き合わせを `signing-key.mjs verify` / `activate` / 署名の瞬間の
 * 3 箇所に置いたが、**誰も `verify` を実行しなければ不一致に気付かない**
 * という穴が残っていた（docs/runbook.md 4.4）。外形から見えるようにする。
 *
 * ここで確かめたいのは 3 値の意味の区別そのもの。とくに `not_published`
 * ——「署名はできるが JWKS に出ていない」—— は、全 RP で一斉に検証失敗する
 * のに auth-worker のログには何も出ない壊れ方で、`unavailable` と
 * 混ぜてしまうと運用者がどちらを直せばよいか分からなくなる。
 */
describe("JoseSigningKeyProvider — checkHealth", () => {
  function providerFor(
    metadata: InMemorySigningKeyMetadataRepository,
    secret: string | null,
  ): JoseSigningKeyProvider {
    return new JoseSigningKeyProvider(
      metadata,
      clock,
      secret === null ? null : { jwk: secret, kid: null },
      "secret is missing",
    );
  }

  it("現役鍵が Secret にあり JWKS にも出ていれば ok", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    const metadata = new InMemorySigningKeyMetadataRepository();
    metadata.seed(aRow({ kid: key.kid, publicJwk: JSON.stringify(key.publicJwk) }));

    const provider = providerFor(metadata, JSON.stringify({ keys: [key.privateJwk] }));

    expect(await provider.checkHealth()).toBe("ok");
    // 同じ入力で実際に署名できることも確かめる。検査と実態がずれないのが
    // この設計の狙いなので、検査だけ緑になっても意味が無い。
    expect((await provider.getActiveSigningKey()).kid).toBe(key.kid);
  });

  it("Secret が未設定なら unavailable", async () => {
    expect(await providerFor(new InMemorySigningKeyMetadataRepository(), null).checkHealth()).toBe(
      "unavailable",
    );
  });

  it("Secret が壊れていても投げずに unavailable", async () => {
    // `/health` が 500 を返したら死活監視として役に立たない。
    const provider = providerFor(new InMemorySigningKeyMetadataRepository(), "{ not json");

    expect(await provider.checkHealth()).toBe("unavailable");
  });

  it("現役の行が無ければ unavailable", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    const metadata = new InMemorySigningKeyMetadataRepository();
    // runbook 4.2 ステップ 2 の途中: 先行公開しただけで active_from が未来。
    metadata.seed(
      aRow({
        kid: key.kid,
        publicJwk: JSON.stringify(key.publicJwk),
        activeFrom: new Date(NOW.getTime() + DAY),
      }),
    );

    expect(
      await providerFor(metadata, JSON.stringify({ keys: [key.privateJwk] })).checkHealth(),
    ).toBe("unavailable");
  });

  it("Secret と行の公開鍵が別物なら unavailable", async () => {
    // kid は合っているが中身が違う。署名は通ってしまうが JWKS の鍵では
    // 検証できない（#23 (c) の核心）。
    const [signing, other] = await Promise.all([
      generateSigningKey("u18-2026-10-24-1"),
      generateSigningKey("u18-2026-10-24-1"),
    ]);
    const metadata = new InMemorySigningKeyMetadataRepository();
    metadata.seed(aRow({ kid: signing.kid, publicJwk: JSON.stringify(other.publicJwk) }));

    expect(
      await providerFor(metadata, JSON.stringify({ keys: [signing.privateJwk] })).checkHealth(),
    ).toBe("unavailable");
  });

  it("署名はできるが JWKS に出ない行は not_published", async () => {
    // `public_jwk` の `kty` だけが壊れている行。`auditSigningKeySecret` は
    // crv / x / y しか比べないので突き合わせは通るが、JWKS を組み立てる
    // `toPublicJwk` は ES256 以外を弾くので配られない。
    //
    // 「行がある」ではなく「配られる」を見ていないと捕まらないケース。
    const key = await generateSigningKey("u18-2026-10-24-1");
    const metadata = new InMemorySigningKeyMetadataRepository();
    metadata.seed(
      aRow({
        kid: key.kid,
        publicJwk: JSON.stringify({ ...key.publicJwk, kty: "RSA" }),
      }),
    );
    const provider = providerFor(metadata, JSON.stringify({ keys: [key.privateJwk] }));

    expect(await provider.getPublicJwks(), "前提: JWKS に出ていない").toEqual([]);
    // 署名自体はできてしまう。だから「署名できるか」だけでは検知できない。
    expect((await provider.getActiveSigningKey()).kid).toBe(key.kid);
    expect(await provider.checkHealth()).toBe("not_published");
  });

  it("D1 が読めなくても投げない", async () => {
    const key = await generateSigningKey("u18-2026-10-24-1");
    const failing = {
      listPublishable: () => Promise.reject(new Error("D1_ERROR: network")),
      findByKid: () => Promise.reject(new Error("D1_ERROR: network")),
    } as unknown as InMemorySigningKeyMetadataRepository;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      await providerFor(failing, JSON.stringify({ keys: [key.privateJwk] })).checkHealth(),
    ).toBe("unavailable");

    errors.mockRestore();
  });
});

describe("signingKeyHealth", () => {
  const audit = (signingKid: string | null) => ({ secretKids: [], signingKid, issues: [] });

  it.each([
    ["署名できて配られている", "kid-a", ["kid-a", "kid-b"], "ok"],
    ["署名できるが配られていない", "kid-a", ["kid-b"], "not_published"],
    ["署名できない", null, ["kid-a"], "unavailable"],
    // 署名できないほうが先。どちらも壊れているときに not_published と
    // 言うと、運用者は JWKS を直しに行って空振りする。
    ["両方壊れている", null, [], "unavailable"],
  ])("%s", (_label, signingKid, published, expected) => {
    expect(signingKeyHealth(audit(signingKid as string | null), published as string[])).toBe(
      expected,
    );
  });
});
