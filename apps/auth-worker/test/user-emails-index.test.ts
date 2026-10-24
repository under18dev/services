import { env } from "cloudflare:test";
import { createIdentityDatabase, userEmails, users } from "@u18/db";
import { newId } from "@u18/domain";
import { aUser, type UserFixture } from "@u18/testing";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./helpers";

/**
 * `user_emails_email_unique` が「確認済みの行だけ」に効くことを確かめる。
 *
 * この索引を無条件にすると、確認を完了しないサインアップが他人のアドレスを
 * 占有でき、本来の持ち主が登録できなくなる。所有を誰も証明していない行で
 * 登録が塞がるのが問題なので、未確認行は重複を許す必要がある。
 *
 * スキーマではなく実際に適用されたマイグレーション越しに検証する。
 * `WHERE` 句を落としても TypeScript は通ってしまうため、SQLite に
 * 聞くのでなければ回帰を捕まえられない。
 */
describe("user_emails_email_unique は確認済みの行にだけ効く", () => {
  let db: ReturnType<typeof createIdentityDatabase>;
  let alice: UserFixture;
  let bob: UserFixture;

  const SHARED = "shared@example.com";

  async function insertUser(user: UserFixture): Promise<void> {
    await db
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

  /** `verifiedAt` が null なら未確認のアドレス。 */
  function addEmail(userId: string, email: string, verifiedAt: Date | null) {
    return db
      .insert(userEmails)
      .values({ id: newId("uem"), userId, email, verifiedAt })
      .run();
  }

  /**
   * 一意制約違反で落ちたことを確かめる。
   *
   * Drizzle は元の例外を「Failed query: ...」で包むので、SQLite の
   * メッセージは `cause` 側にしか出てこない。単に throw したことだけを
   * 見ると、別の理由（FK 違反など）で落ちていても通ってしまう。
   */
  async function expectUniqueViolation(run: () => Promise<unknown>): Promise<void> {
    let thrown: unknown;
    try {
      await run();
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "クエリが成功してしまった").toBeDefined();

    const messages: string[] = [];
    let current: unknown = thrown;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join(" / ")).toMatch(/UNIQUE constraint failed/i);
  }

  beforeEach(async () => {
    await resetDatabase();
    db = createIdentityDatabase(env.IDENTITY_DB);
    alice = aUser();
    bob = aUser();
    await insertUser(alice);
    await insertUser(bob);
  });

  it("未確認のアドレスは複数アカウントが同時に持てる", async () => {
    await addEmail(alice.id, SHARED, null);

    // ここが落ちると事前登録ロックアウトが成立する。
    await expect(addEmail(bob.id, SHARED, null)).resolves.toBeDefined();
  });

  it("確認済みのアドレスを 2 アカウントが同時に持てない", async () => {
    await addEmail(alice.id, SHARED, new Date("2026-10-24T00:00:00.000Z"));

    await expectUniqueViolation(() =>
      addEmail(bob.id, SHARED, new Date("2026-10-24T00:00:00.000Z")),
    );
  });

  it("確認済み同士の衝突は大文字小文字を無視して判定される", async () => {
    await addEmail(alice.id, SHARED, new Date("2026-10-24T00:00:00.000Z"));

    await expectUniqueViolation(() =>
      addEmail(bob.id, SHARED.toUpperCase(), new Date("2026-10-24T00:00:00.000Z")),
    );
  });

  it("他人が未確認で占有していても、本来の持ち主は確認済みとして登録できる", async () => {
    // 攻撃者が被害者のアドレスでサインアップを始め、確認を完了しない。
    await addEmail(bob.id, SHARED, null);

    // 被害者は自分のアドレスを確認済みとして登録できなければならない。
    await expect(
      addEmail(alice.id, SHARED, new Date("2026-10-24T00:00:00.000Z")),
    ).resolves.toBeDefined();
  });

  it("未確認の行をあとから確認済みにするとき、既存の確認済みと衝突する", async () => {
    await addEmail(alice.id, SHARED, new Date("2026-10-24T00:00:00.000Z"));
    const pending = newId("uem");
    await db
      .insert(userEmails)
      .values({ id: pending, userId: bob.id, email: SHARED, verifiedAt: null })
      .run();

    // 部分インデックスは「確認済みになった瞬間」に効く。
    // UPDATE で初めて弾かれるので、OTP 検証側はこの失敗を扱う必要がある。
    await expectUniqueViolation(() =>
      db
        .update(userEmails)
        .set({ verifiedAt: new Date("2026-10-24T01:00:00.000Z") })
        .where(eq(userEmails.id, pending))
        .run(),
    );
  });
});
