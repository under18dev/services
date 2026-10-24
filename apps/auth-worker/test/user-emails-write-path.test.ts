import { env } from "cloudflare:test";
import { createIdentityDatabase, userEmails, users } from "@u18/db";
import { newId } from "@u18/domain";
import { aUser, type UserFixture } from "@u18/testing";
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DrizzleUserRepository } from "../src/infrastructure/persistence/drizzle-user.repository";
import { expectUniqueViolation, resetDatabase } from "./helpers";

/**
 * `user_emails` へ書く経路（#96）。
 *
 * ## 何を正本にしたか
 *
 * **一意性の正本は `users.primary_email` のまま**で、`user_emails` は「どの
 * アドレスがいつ確認されたか」の台帳として書く。設計当初のコメントは
 * `user_emails` を正本と書いていたが、仕様書 §14.1 決定 7（物理削除せず凍結で
 * 表現する）と両立しない —— `user_emails_email_unique` は確認済みの行だけに
 * 効く部分インデックスなので、そこへ占有判定を預けると**未確認のまま凍結した
 * アカウントのアドレスが解放される**。正本は自分の一意性を裁けなければならず、
 * 無条件にそれができるのは `users_primary_email_unique` だけである。
 *
 * ## 2 つの索引の非対称をどう扱うか
 *
 * 揃えずに**役割を分けた**。新規アカウントがそのアドレスを取れるかを決めるのは
 * `users_primary_email_unique` だけ、`user_emails_email_unique` は「同じアドレスを
 * 2 人が確認済みとして持てない」ことだけを見る。`create()` の batch では users
 * への INSERT が先に走るので、凍結アドレスでの再登録は user_emails の判定へ
 * 届かずに落ちる。この順序が成り立っていることを下で実測する。
 */
describe("DrizzleUserRepository が user_emails へ書く", () => {
  let db: ReturnType<typeof createIdentityDatabase>;
  let repo: DrizzleUserRepository;

  beforeEach(async () => {
    await resetDatabase();
    db = createIdentityDatabase(env.IDENTITY_DB);
    repo = new DrizzleUserRepository(db);
  });

  function create(fixture: UserFixture, emailVerified = true) {
    return repo.create({
      id: fixture.id,
      username: fixture.username,
      displayName: fixture.displayName,
      email: fixture.email,
      emailVerified,
    });
  }

  /** users へ直接書く。Repository を通さず「既に居る他人」を用意するため。 */
  function seedUser(fixture: UserFixture) {
    return db
      .insert(users)
      .values({
        id: fixture.id,
        username: fixture.username,
        displayName: fixture.displayName,
        primaryEmail: fixture.email,
        emailVerified: fixture.emailVerified,
        status: fixture.status,
        deletedAt: fixture.deletedAt,
      })
      .run();
  }

  function ledgerOf(userId: string) {
    return db
      .select()
      .from(userEmails)
      .where(eq(userEmails.userId, userId))
      .orderBy(asc(userEmails.createdAt))
      .all();
  }

  describe("create()", () => {
    it("users と user_emails の両方に行ができる", async () => {
      // #96 の本体。ここが 0 件に戻ったら、台帳が空に戻って
      // user_emails_email_unique が再び何も守らなくなる。
      const fixture = aUser();
      const created = await create(fixture);

      const ledger = await ledgerOf(created.id);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.email).toBe(fixture.email);
      expect(ledger[0]?.isPrimary).toBe(true);
    });

    it("確認済みで作ると verified_at が入る", async () => {
      const created = await create(aUser());

      const ledger = await ledgerOf(created.id);
      expect(ledger[0]?.verifiedAt).toBeInstanceOf(Date);
    });

    it("未確認で作ると verified_at は null のまま", async () => {
      // ここを既定で「確認済み」にすると、所有を誰も証明していない行が
      // user_emails_email_unique を占有し、本来の持ち主を締め出す（#54 / #60）。
      const created = await create(aUser(), false);

      const ledger = await ledgerOf(created.id);
      expect(ledger[0]?.verifiedAt).toBeNull();
    });

    it("凍結アカウントのアドレスでは作れない（#51 決定 7）", async () => {
      const frozen = aUser({ status: "suspended" });
      await seedUser(frozen);

      // 落ちるのは users_primary_email_unique。user_emails 側の部分
      // インデックスは未確認行を通してしまうが、そこまで到達しない。
      await expectUniqueViolation(() => create(aUser({ email: frozen.email })));
    });

    it("users 側で落ちたとき user_emails にも行が残らない", async () => {
      // **batch の巻き戻しの実測。** D1 の batch は暗黙のトランザクションなので、
      // 1 文目が落ちれば 2 文目は適用されない。ここが崩れると、登録に失敗した
      // アドレスの未確認行が台帳に溜まり、後から本人が確認しようとしたときに
      // user_emails_user_email_unique で説明のつかない失敗になる。
      const frozen = aUser({ status: "suspended" });
      await seedUser(frozen);

      await expectUniqueViolation(() => create(aUser({ email: frozen.email })));

      expect(await db.select().from(userEmails).all()).toHaveLength(0);
      expect(await db.select().from(users).all()).toHaveLength(1);
    });

    it("同じユーザーが同じアドレスの行を 2 本持てない", async () => {
      const created = await create(aUser());

      await expectUniqueViolation(() =>
        db
          .insert(userEmails)
          .values({ id: newId("uem"), userId: created.id, email: created.email })
          .run(),
      );
    });

    it("1 ユーザーの is_primary は 1 行だけ", async () => {
      // users.primary_email が正本である以上、それを指す写しが 2 本あると
      // どちらが現在の値なのか行からは決められない。
      const created = await create(aUser());

      await expectUniqueViolation(() =>
        db
          .insert(userEmails)
          .values({
            id: newId("uem"),
            userId: created.id,
            email: `other-${created.email}`,
            isPrimary: true,
          })
          .run(),
      );
    });
  });

  describe("markEmailVerified()", () => {
    it("台帳側の verified_at も立つ", async () => {
      // users.email_verified だけ立てると、確認済みかどうかを user_emails で
      // 判断する処理からは未確認に見え続ける（#96）。
      const created = await create(aUser(), false);

      await repo.markEmailVerified(created.id, created.email);

      const ledger = await ledgerOf(created.id);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.verifiedAt).toBeInstanceOf(Date);
    });

    it("大文字小文字が違っても既存の行に当たり、行は増えない", async () => {
      // 索引が lower(email) で引く以上、upsert の衝突判定も同じでなければ
      // 「同じアドレスなのに別の行」が増える。
      const created = await create(aUser({ email: "mixed@example.com" }), false);

      await repo.markEmailVerified(created.id, "Mixed@Example.COM");

      expect(await ledgerOf(created.id)).toHaveLength(1);
    });

    it("2 回呼んでも最初の確認時刻が残る", async () => {
      // ログインのたびに上書きすると「いつから確認済みか」が監査から読めなくなる。
      const created = await create(aUser(), false);
      await repo.markEmailVerified(created.id, created.email);
      const first = (await ledgerOf(created.id))[0]?.verifiedAt;

      await repo.markEmailVerified(created.id, created.email);

      expect((await ledgerOf(created.id))[0]?.verifiedAt).toEqual(first);
    });

    it("別アドレスを確認すると、古い写しの is_primary が降りる", async () => {
      const created = await create(aUser({ email: "old@example.com" }), false);

      await repo.markEmailVerified(created.id, "new@example.com");

      const ledger = await ledgerOf(created.id);
      expect(ledger).toHaveLength(2);
      expect(ledger.find((row) => row.email === "old@example.com")?.isPrimary).toBe(false);
      expect(ledger.find((row) => row.email === "new@example.com")?.isPrimary).toBe(true);
    });

    it("他人が確認済みのアドレスは確認済みにできない", async () => {
      // user_emails_email_unique の本来の仕事。台帳に行が書かれるように
      // なって初めて、この判定が実際に効く。
      const owner = await create(aUser({ email: "owner@example.com" }));
      const other = await create(aUser({ email: "other@example.com" }), false);
      expect(owner.id).not.toBe(other.id);

      await expectUniqueViolation(() => repo.markEmailVerified(other.id, "owner@example.com"));
    });

    it("台帳側で落ちたとき users.email_verified も立たない（batch の巻き戻し）", async () => {
      // **batch の巻き戻しの実測（途中の文が落ちる場合）。** 片方だけ確認済みに
      // なると、「このアドレスは確認済みか」の答えが users と user_emails で
      // 食い違う —— #62 が指摘したねじれが実データとして生まれる。
      await create(aUser({ email: "owner@example.com" }));
      const other = await create(aUser({ email: "other@example.com" }), false);

      await expectUniqueViolation(() => repo.markEmailVerified(other.id, "owner@example.com"));

      const row = await db.select().from(users).where(eq(users.id, other.id)).get();
      expect(row?.emailVerified).toBe(false);
      expect(row?.primaryEmail).toBe("other@example.com");
      // 1 文目（古い写しの is_primary を降ろす UPDATE）も巻き戻ること。
      const ledger = await ledgerOf(other.id);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.isPrimary).toBe(true);
    });
  });

  /**
   * #96 より前に作られた `users` 行には台帳の写しが無い。
   *
   * 書く経路を足しただけでは既存行が穴のまま残り、その利用者に対しては
   * `user_emails_email_unique` が守るべき行を見つけられない。`0003` の
   * バックフィルがその穴を埋めることを、マイグレーション本体を流して確かめる。
   * SQL をテストに書き写すと静かにずれるので、`TEST_MIGRATIONS` から読む。
   */
  describe("0003 のバックフィル", () => {
    /**
     * vitest.config.ts が読み込んだ 0003 の SQL を、`exec` に渡せる形にする。
     *
     * D1 の `exec` は改行で文を区切るので、1 行へ畳む。`--` コメントは行末まで
     * 効くため、畳む前に落とさないと文全体がコメントとして消える。
     */
    function backfillSql(): string {
      const migrations = (env as unknown as { TEST_MIGRATIONS: readonly Migration[] })
        .TEST_MIGRATIONS;
      const target = migrations.find((entry) => entry.name.startsWith("0003_"));
      if (target === undefined) throw new Error("0003 のマイグレーションが見つからない");
      return target.queries
        .join("\n")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join(" ");
    }

    /** 1 行に畳んだ 0003 を流す。 */
    function runBackfill(): Promise<unknown> {
      return env.IDENTITY_DB.exec(backfillSql());
    }

    it("写しの無い既存行に is_primary の行を足す", async () => {
      const legacy = aUser();
      await seedUser(legacy);

      await runBackfill();

      const ledger = await ledgerOf(legacy.id);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.email).toBe(legacy.email);
      expect(ledger[0]?.isPrimary).toBe(true);
      // 確認済みの users 行だけ verified_at が入る。
      expect(ledger[0]?.verifiedAt).toBeInstanceOf(Date);
    });

    it("未確認の既存行は未確認のまま埋める", async () => {
      // 到達性を誰も確かめていないアドレスを確認済みとして記録すると、
      // 本来の持ち主が確認済みとして登録できなくなる（#54 / #60）。
      const legacy = aUser({ emailVerified: false });
      await seedUser(legacy);

      await runBackfill();

      expect((await ledgerOf(legacy.id))[0]?.verifiedAt).toBeNull();
    });

    it("写しが既にある行は二重に埋めない", async () => {
      // 再実行しても壊れないこと。適用済みの環境へ当て直す事故は起こりうる。
      const created = await create(aUser());

      await runBackfill();

      expect(await ledgerOf(created.id)).toHaveLength(1);
    });
  });
});

/** `readD1Migrations` が返す 1 件分。 */
type Migration = { readonly name: string; readonly queries: readonly string[] };
