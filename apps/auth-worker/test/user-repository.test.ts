import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
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

/**
 * `touchLastActive` を**実際のマイグレーション越しに**確かめる（#286）。
 *
 * **use-case のテストは `InMemoryUserRepository` を使う。** あちらは
 * `touchLastActive` を Map に入れるだけなので、**列名を間違えていても
 * drizzle の対応がずれていても緑になる。** 保持期間の起点は
 * 「1 年後に読めること」が全てなので、**本当に行に入るか**をここで見る。
 */
describe("DrizzleUserRepository.touchLastActive", () => {
  let repo: DrizzleUserRepository;
  let user: UserFixture;

  beforeEach(async () => {
    await resetDatabase();
    repo = new DrizzleUserRepository(createIdentityDatabase(env.IDENTITY_DB));
    user = aUser({ username: "active_one" });
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
  });

  async function rowOf(id: string) {
    return await createIdentityDatabase(env.IDENTITY_DB)
      .select({ lastActiveAt: users.lastActiveAt, updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, id))
      .get();
  }

  it("入れた直後は NULL（洗い出しに拾われない側）", async () => {
    expect((await rowOf(user.id))?.lastActiveAt).toBeNull();
  });

  it("書いた時刻が行に残る", async () => {
    const at = new Date("2026-10-29T08:00:00.000Z");

    await repo.touchLastActive(user.id, at);

    expect((await rowOf(user.id))?.lastActiveAt).toEqual(at);
  });

  it("updated_at を進めない（OIDC の公開クレームである）", async () => {
    // **`users.updated_at` は内部の記録ではない。** `User.toClaims()` が
    // OIDC の標準クレームとして外へ出し、**RP はこれを見てプロフィールを
    // 取り直すかを決める。** ログインのたびに進めると、何も変わって
    // いないのに取り直させることになる。
    //
    // `update-profile.use-case.ts` が「同じ値なら書き込まない」理由と
    // 同じで、**列ごとの例外ではなく、既にある規則に揃えている。**
    //
    // drizzle の `update()` は `$onUpdateFn` が必ず触るので、ここは
    // 生の SQL で書いてある。**この検査がその実装を固定する。**
    const before = (await rowOf(user.id))?.updatedAt;

    await repo.touchLastActive(user.id, new Date("2026-10-29T08:00:00.000Z"));

    expect((await rowOf(user.id))?.updatedAt).toEqual(before);
  });

  it("居ないユーザーでも落ちない", async () => {
    // 副作用として `settleSideEffects` から呼ばれるので、例外を投げると
    // ログインのログに毎回エラーが出る。
    await expect(repo.touchLastActive("usr_missing", new Date())).resolves.toBeUndefined();
  });
});
