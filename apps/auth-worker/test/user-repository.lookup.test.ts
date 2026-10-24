import { env } from "cloudflare:test";
import { createIdentityDatabase, users } from "@u18/db";
import { aUser, type UserFixture } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { DrizzleUserRepository } from "../src/infrastructure/persistence/drizzle-user.repository";
import { resetDatabase } from "./helpers";

/**
 * 検索と一意制約を、実際に適用されたマイグレーション越しに確かめる（#12）。
 *
 * `users_username_unique` と `users_primary_email_unique` はどちらも
 * `lower(...)` の式インデックスとして張られている。インメモリの代替実装では
 * `toLowerCase()` を自分で書くので必ず通ってしまい、**索引が本当に lower() で
 * 張られているか**は検証できない。ここだけは実 D1 に当てる必要がある。
 */
describe("DrizzleUserRepository の検索と一意制約", () => {
  let repo: DrizzleUserRepository;
  let user: UserFixture;

  async function insertUser(fixture: UserFixture): Promise<void> {
    await createIdentityDatabase(env.IDENTITY_DB)
      .insert(users)
      .values({
        id: fixture.id,
        username: fixture.username,
        displayName: fixture.displayName,
        primaryEmail: fixture.email,
        emailVerified: fixture.emailVerified,
      })
      .run();
  }

  beforeEach(async () => {
    await resetDatabase();
    repo = new DrizzleUserRepository(createIdentityDatabase(env.IDENTITY_DB));
    user = aUser({ username: "Taro_Yamada", email: "Taro@Example.COM" });
    await insertUser(user);
  });

  describe("findByEmail", () => {
    it("大文字小文字を無視して引ける", async () => {
      // 利用者が入力するアドレスの字形は毎回同じとは限らない。
      // ここで取りこぼすと、同じ人が二重に登録できてしまう。
      for (const input of ["Taro@Example.COM", "taro@example.com", "TARO@EXAMPLE.COM"]) {
        const found = await repo.findByEmail(input);
        expect(found?.id, input).toBe(user.id);
      }
    });

    it("存在しないアドレスでは null を返す", async () => {
      expect(await repo.findByEmail("nobody@example.com")).toBeNull();
    });
  });

  describe("findByUsername", () => {
    it("大文字小文字を無視して引ける", async () => {
      for (const input of ["Taro_Yamada", "taro_yamada", "TARO_YAMADA"]) {
        const found = await repo.findByUsername(input);
        expect(found?.id, input).toBe(user.id);
      }
    });

    it("存在しない username では null を返す", async () => {
      expect(await repo.findByUsername("nobody")).toBeNull();
    });
  });

  describe("一意インデックスが実際に重複を弾く", () => {
    it("username は大文字小文字を無視して重複を拒む", async () => {
      // 索引が lower() ではなく素の username に張られていると、
      // この挿入が通ってしまう。そうなれば findByUsername が
      // 2 行のうち「どちらか」を返す非決定的な状態になる。
      await expect(insertUser(aUser({ username: "TARO_YAMADA" }))).rejects.toThrow();
    });

    it("primaryEmail は大文字小文字を無視して重複を拒む", async () => {
      await expect(insertUser(aUser({ email: "TARO@EXAMPLE.COM" }))).rejects.toThrow();
    });

    it("別の username / アドレスなら挿入できる", async () => {
      // 対照群。上の 2 件が「何を入れても落ちる」状態で通っていないことを示す。
      await expect(
        insertUser(aUser({ username: "hanako", email: "hanako@example.com" })),
      ).resolves.toBeUndefined();
    });
  });
});
