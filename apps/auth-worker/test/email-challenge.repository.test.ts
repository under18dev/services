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

  describe("countSentSinceForPurpose（#236）", () => {
    /**
     * **本物の D1 で数える。** 総量の層は in-memory の fake でも固定して
     * あるが（`otp-global-cap.test.ts`）、#88 で痛い目を見たとおり
     * **fake と本物がずれていると、fake だけが穴を塞いでいる状態になる。**
     * ここでしか分からないのは「SQL が実際にその行を数えるか」である。
     */
    /**
     * **`created_at` を指定したいので `repo.create()` は使えない。**
     * あちらは挿入時刻を自動で入れる（schema の `createdAt()`）。窓の
     * 外側にある行を作るには直接入れるしかない。
     */
    const seedFor = async (
      email: string,
      purpose: "login" | "signup",
      createdAt: Date,
    ): Promise<void> => {
      await db
        .insert(emailChallenges)
        .values({
          id: `emc_${Math.random().toString(36).slice(2, 10)}`,
          userId: null,
          email,
          codeHash: "f".repeat(64),
          purpose,
          expiresAt: new Date(createdAt.getTime() + 5 * 60 * 1000),
          maxAttempts: 5,
          lastSentAt: createdAt,
          createdAt,
        })
        .run();
    };

    it("宛先が違っても同じ用途なら数える", async () => {
      // **これが `countSentSince` との違い。** あちらはアドレスで絞るので、
      // 宛先を変える攻撃は 1 件ずつに散って上限に届かない。
      await seedFor("a@example.test", "signup", NOW);
      await seedFor("b@example.test", "signup", NOW);
      await seedFor("c@example.test", "signup", NOW);

      const since = new Date(NOW.getTime() - 1000);
      expect(await repo.countSentSinceForPurpose("signup", since)).toBe(3);
    });

    it("用途が違えば数えない", async () => {
      await seedFor("a@example.test", "signup", NOW);
      await seedFor("b@example.test", "login", NOW);

      const since = new Date(NOW.getTime() - 1000);
      expect(await repo.countSentSinceForPurpose("signup", since)).toBe(1);
      expect(await repo.countSentSinceForPurpose("login", since)).toBe(1);
    });

    it("窓より前の行は数えない", async () => {
      const old = new Date(NOW.getTime() - 60 * 60 * 1000);
      await seedFor("a@example.test", "signup", old);
      await seedFor("b@example.test", "signup", NOW);

      expect(await repo.countSentSinceForPurpose("signup", new Date(NOW.getTime() - 1000))).toBe(1);
    });

    it("消費済み・期限切れも数える", async () => {
      // `countSentSince` と同じ理由。**数えているのは「送った事実」**で、
      // 行が使えるかどうかは関係ない。除外すると invalidateActive() が
      // 送信履歴を消してしまい、上限が効かなくなる（#88 の原形）。
      await seedFor("a@example.test", "signup", NOW);
      await repo.invalidateActive("a@example.test", "signup", LATER);
      await seedFor("b@example.test", "signup", NOW);

      expect(await repo.countSentSinceForPurpose("signup", new Date(NOW.getTime() - 1000))).toBe(2);
    });

    it("インデックスだけで閉じる", async () => {
      /**
       * **インデックスは「速い」と宣言するが、効いているかは何も言わない。**
       * 足しても使われないことがあり（`lower()` を掛ければ外れる）、
       * そのとき**答えは正しいまま遅くなるだけ**なので、ふつうのテストでは
       * 永久に捕まらない。実際このテーブルには、使われていないインデックスが
       * 既に 1 本ある（`countSentSince` が `lower(email)` を掛けているため
       * `(email, purpose)` が効かない）。
       *
       * そこでプランそのものを見る。**この層がいちばん重くなるのは
       * 大量送信が起きている最中**で、そこでフルスキャンに落ちていると
       * 守りたい状況で守りが重くなる。
       *
       * プランは統計にも依存しうるので、`SCAN` でないことと索引名の 2 点だけ
       * 見る。実行計画の文言そのものを固定はしない。
       */
      const plan = await env.IDENTITY_DB.prepare(
        "EXPLAIN QUERY PLAN SELECT count(*) FROM email_challenges WHERE purpose = ? AND created_at > ?",
      )
        .bind("signup", 0)
        .all<{ detail: string }>();

      const detail = plan.results.map((row) => row.detail).join(" | ");
      expect(detail).toContain("email_challenges_purpose_created_idx");
      expect(detail, "フルスキャンに落ちている").not.toContain("SCAN");
    });

    it("大文字小文字の違う宛先もまとめて数える", async () => {
      // アドレスを見ないので当然そうなるが、**ここが「当然」でなくなる
      // 変更**（`lower()` を足すなど）が入ったら止める。
      await seedFor("A@Example.test", "signup", NOW);
      await seedFor("a@example.test", "signup", NOW);

      expect(await repo.countSentSinceForPurpose("signup", new Date(NOW.getTime() - 1000))).toBe(2);
    });
  });

  describe("どの索引が効いているか（#245）", () => {
    /**
     * **索引は「速い」と宣言するだけで、効いているかは何も言わない。**
     * 効かなくなっても答えは正しいままなので、ふつうのテストでは永久に
     * 捕まらない。
     *
     * このテーブルには実際に**どこからも使われない索引が 1 本あった**
     * （`(email, purpose)`。email で引く経路はすべて `lower(email)` を
     * 掛けるので選ばれない）。#245 で落とした。
     *
     * 落としただけだと「いまどれが効いているか」が誰にも見えないままに
     * なるので、ここに出しておく。**次に索引を足したくなった人が最初に
     * 読む場所**にしたい。
     *
     * プランは統計にも依存しうるので、索引名と `SCAN` でないことの
     * 2 点だけ見る。文言そのものは固定しない。
     */
    const planOf = async (sql: string, binds: unknown[]): Promise<string> => {
      const plan = await env.IDENTITY_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...binds)
        .all<{ detail: string }>();
      return plan.results.map((row) => row.detail).join(" | ");
    };

    it("countSentSince は purpose + created_at の索引で引く", async () => {
      // `lower(email)` があるので email 側の索引は選ばれない。**選ばれない
      // ことが問題なのではなく、選ばれない索引を宣言していたのが問題だった。**
      const detail = await planOf(
        "SELECT count(*) FROM email_challenges" +
          " WHERE lower(email) = lower(?) AND purpose = ? AND created_at > ?",
        ["a@example.test", "signup", 0],
      );

      expect(detail).toContain("email_challenges_purpose_created_idx");
      expect(detail, "フルスキャンに落ちている").not.toContain("SCAN");
    });

    it("invalidateActive も同じ索引で引く（**第 2 列は効いていない**）", async () => {
      /**
       * このクエリは `created_at` を条件に持たないので、
       * `(purpose, created_at)` の**先頭列だけ**を使う。
       *
       * **それで困っていない。** 保持期限は 1 時間で、1 つの purpose に
       * 溜まる行数は多くない。ここに書いてあるのは「足りない」ではなく
       * 「**こうなっていることを知ったうえでそのままにしている**」である。
       *
       * 速くしたくなったら、まず `lower()` を外せないことを確認すること
       * （`packages/db/src/schema/auth.ts` に理由がある）。
       */
      const detail = await planOf(
        "UPDATE email_challenges SET consumed_at = ?" +
          " WHERE lower(email) = lower(?) AND purpose = ? AND consumed_at IS NULL",
        [0, "a@example.test", "signup"],
      );

      expect(detail).toContain("email_challenges_purpose_created_idx");
      expect(detail, "フルスキャンに落ちている").not.toContain("SCAN");
    });

    it("落とした索引はもう存在しない", async () => {
      // schema から消しただけだと、**マイグレーションを当て忘れた環境では
      // 残り続ける。** 実体に聞く。
      const indexes = await env.IDENTITY_DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'email_challenges'",
      ).all<{ name: string }>();
      const names = indexes.results.map((row) => row.name);

      expect(names).not.toContain("email_challenges_email_purpose_idx");
      // 残っているほうも固定する。**落としすぎたら気づきたい。**
      expect(names).toContain("email_challenges_purpose_created_idx");
      expect(names).toContain("email_challenges_expires_idx");
    });
  });
});
