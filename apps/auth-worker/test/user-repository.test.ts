import { env } from "cloudflare:test";
import { createIdentityDatabase, users } from "@u18/db";
import { aUser, type UserFixture } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { DrizzleUserRepository } from "../src/infrastructure/persistence/drizzle-user.repository";
import { resetDatabase } from "./helpers";

/**
 * `updateProfile` の衝突の扱いを、実際に適用されたマイグレーション越しに確かめる。
 *
 * 一意性を裁くのは `users_username_unique`（lower(username)）で、インメモリの
 * 代替では「索引が本当に lower() で張られているか」を検証できない。
 */
describe("DrizzleUserRepository.updateProfile", () => {
  let repo: DrizzleUserRepository;
  let owner: UserFixture;
  let other: UserFixture;

  async function insertUser(user: UserFixture): Promise<void> {
    await createIdentityDatabase(env.IDENTITY_DB)
      .insert(users)
      .values({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        primaryEmail: user.email,
        emailVerified: user.emailVerified,
      })
      .run();
  }

  beforeEach(async () => {
    await resetDatabase();
    repo = new DrizzleUserRepository(createIdentityDatabase(env.IDENTITY_DB));
    owner = aUser({ username: "owner_one" });
    other = aUser({ username: "other_one" });
    await insertUser(owner);
    await insertUser(other);
  });

  it("displayName と username を更新する", async () => {
    const outcome = await repo.updateProfile(owner.id, {
      displayName: "新しい名前",
      username: "owner_two",
    });

    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") return;
    expect(outcome.user.displayName).toBe("新しい名前");
    expect(outcome.user.username).toBe("owner_two");
    // 他人の行は巻き込まない。
    expect((await repo.findById(other.id))?.username).toBe(other.username);
  });

  it("他人が持つ username は大文字小文字を無視して衝突にする", async () => {
    // 例外ではなく値で返す。呼び出し側は 409 へ翻訳するだけで済む。
    const outcome = await repo.updateProfile(owner.id, { username: other.username.toUpperCase() });

    expect(outcome).toEqual({ kind: "username_taken" });
    expect((await repo.findById(owner.id))?.username).toBe(owner.username);
  });

  it("衝突した更新では他の項目も書き換えない", async () => {
    // 条件付き UPDATE なので、1 文まるごと成立しないか、まるごと成立するか。
    await repo.updateProfile(owner.id, {
      displayName: "通ってはいけない名前",
      username: other.username,
    });

    expect((await repo.findById(owner.id))?.displayName).toBe(owner.displayName);
  });

  it("自分が持つ username をそのまま指定しても衝突にしない", async () => {
    const outcome = await repo.updateProfile(owner.id, { username: owner.username });

    expect(outcome.kind).toBe("updated");
  });

  it("居ないユーザーの更新は not_found", async () => {
    // 「名前が取られている」と区別できないと、呼び出し側が 409 と 401 を
    // 取り違える。行が返らない理由をここで切り分ける。
    const outcome = await repo.updateProfile("usr_does_not_exist", { username: "someone_new" });

    expect(outcome).toEqual({ kind: "not_found" });
  });

  it("変更が空なら現在の値を返す", async () => {
    const outcome = await repo.updateProfile(owner.id, {});

    expect(outcome.kind).toBe("updated");
    if (outcome.kind === "updated") expect(outcome.user.username).toBe(owner.username);
  });
});
