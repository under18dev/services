import { env } from "cloudflare:test";
import { createIdentityDatabase, emailChallenges } from "@u18/db";
import { beforeEach, describe, expect, it } from "vitest";
import { DrizzleEmailChallengeRepository } from "../src/infrastructure/persistence/drizzle-email-challenge.repository";
import { resetDatabase } from "./helpers";

const NOW = new Date("2026-10-24T00:00:00.000Z");
const LATER = new Date("2026-10-24T00:01:00.000Z");
const EMAIL = "taro@example.com";

describe("DrizzleEmailChallengeRepository", () => {
  let repo: DrizzleEmailChallengeRepository;
  let db: ReturnType<typeof createIdentityDatabase>;

  beforeEach(async () => {
    await resetDatabase();
    db = createIdentityDatabase(env.IDENTITY_DB);
    repo = new DrizzleEmailChallengeRepository(db);
  });

  const seed = (
    overrides: Partial<{ codeHash: string; expiresAt: Date; maxAttempts: number }> = {},
  ) =>
    repo.create({
      id: `emc_${Math.random().toString(36).slice(2, 10)}`,
      userId: null,
      email: EMAIL,
      codeHash: overrides.codeHash ?? "hash-of-123456",
      purpose: "login",
      expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 5 * 60 * 1000),
      maxAttempts: overrides.maxAttempts ?? 5,
      sentAt: NOW,
    });

  it("正しいコードで消費できる", async () => {
    await seed();
    const result = await repo.consume(EMAIL, "login", "hash-of-123456", LATER);
    expect(result.outcome).toBe("consumed");
  });

  it("同じコードを 2 回は使えない", async () => {
    await seed();
    await repo.consume(EMAIL, "login", "hash-of-123456", LATER);

    const second = await repo.consume(EMAIL, "login", "hash-of-123456", LATER);
    expect(second.outcome).toBe("unusable");
  });

  it("同時に消費しても成功は 1 回だけ", async () => {
    // 照合・加算・消費を分けて実装すると、ここで 2 回成功しうる（仕様書 7.3）。
    await seed();

    const results = await Promise.all([
      repo.consume(EMAIL, "login", "hash-of-123456", LATER),
      repo.consume(EMAIL, "login", "hash-of-123456", LATER),
      repo.consume(EMAIL, "login", "hash-of-123456", LATER),
    ]);

    expect(results.filter((r) => r.outcome === "consumed")).toHaveLength(1);
  });

  it("誤ったコードは試行回数を進める", async () => {
    await seed();
    const first = await repo.consume(EMAIL, "login", "wrong", LATER);

    expect(first).toEqual({ outcome: "mismatch", attemptsRemaining: 4 });
  });

  it("試行上限に達したら正しいコードでも受け付けない", async () => {
    await seed({ maxAttempts: 2 });
    await repo.consume(EMAIL, "login", "wrong", LATER);
    await repo.consume(EMAIL, "login", "wrong", LATER);

    const result = await repo.consume(EMAIL, "login", "hash-of-123456", LATER);
    expect(result.outcome).toBe("exhausted");
  });

  it("期限切れのコードは使えない", async () => {
    await seed({ expiresAt: new Date(NOW.getTime() - 1000) });

    const result = await repo.consume(EMAIL, "login", "hash-of-123456", LATER);
    expect(result.outcome).toBe("unusable");
  });

  it("存在しないアドレスでも例外にならない", async () => {
    const result = await repo.consume("nobody@example.com", "login", "x", LATER);
    expect(result.outcome).toBe("unusable");
  });

  it("用途が違うコードは使えない", async () => {
    await seed();
    const result = await repo.consume(EMAIL, "recovery", "hash-of-123456", LATER);
    expect(result.outcome).toBe("unusable");
  });

  it("メールアドレスの大文字小文字を区別しない", async () => {
    await seed();
    const result = await repo.consume("TARO@EXAMPLE.COM", "login", "hash-of-123456", LATER);
    expect(result.outcome).toBe("consumed");
  });

  it("invalidateActive で古いコードを潰せる", async () => {
    await seed({ codeHash: "old" });
    expect(await repo.invalidateActive(EMAIL, "login", LATER)).toBe(1);

    const result = await repo.consume(EMAIL, "login", "old", LATER);
    expect(result.outcome).toBe("unusable");
  });

  it("渡されたハッシュをそのまま保存し、平文の痕跡を残さない", async () => {
    // 実際のハッシュに近い値を使う。"hash-of-123456" のような値だと
    // 平文を文字列検索するアサーションが素通りしてしまう。
    const codeHash = "e".repeat(64);
    await seed({ codeHash });

    const rows = await db.select().from(emailChallenges).all();

    expect(rows[0]?.codeHash).toBe(codeHash);
    // 行のどの列にも平文のコードが現れないこと。
    expect(JSON.stringify(rows)).not.toContain("123456");
  });
});
