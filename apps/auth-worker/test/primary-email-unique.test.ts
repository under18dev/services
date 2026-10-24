import { env } from "cloudflare:test";
import { createIdentityDatabase, userEmails, users } from "@u18/db";
import { FixedClock, aUser, type UserFixture } from "@u18/testing";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { StartEmailOtpUseCase } from "../src/application/use-cases/start-email-otp.use-case";
import { WebCryptoTokenGenerator } from "../src/infrastructure/crypto/web-crypto";
import { DrizzleUserRepository } from "../src/infrastructure/persistence/drizzle-user.repository";
import { FakeHasher, InMemoryUserRepository, RecordingAuditLogger } from "./fakes";
import { InMemoryEmailChallengeRepository, RecordingEmailSender } from "./fakes.otp";
import { expectUniqueViolation, resetDatabase } from "./helpers";

/**
 * `users_primary_email_unique` は**無条件**であり、そのままでなければならない（#62）。
 *
 * `user_emails_email_unique` を確認済みの行だけに限ったのは（#60 / #54）、
 * 他人が未確認で占有して本来の持ち主を締め出す事前登録ロックアウトを防ぐため。
 * **同じ理屈を `users` 側へ持ち込んではいけない。**
 *
 * #51 で「アカウントは物理削除せず、凍結 / BAN / 無効化で表現する」が決まった
 * （仕様書 §14.1 決定 7）。行が残り続ける以上、`users` 側の一意性を緩めると
 * **凍結したアカウントのアドレスで新規登録できてしまい、BAN の意味が無くなる。**
 *
 * 2 つの索引が別の意味を持つことを、ここで実際の SQLite に聞いて固定する。
 */
describe("users_primary_email_unique は無条件", () => {
  let db: ReturnType<typeof createIdentityDatabase>;

  const SHARED = "shared@example.com";

  function insertUser(user: UserFixture) {
    return db
      .insert(users)
      .values({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        primaryEmail: user.email,
        emailVerified: user.emailVerified,
        status: user.status,
        deletedAt: user.deletedAt,
      })
      .run();
  }

  beforeEach(async () => {
    await resetDatabase();
    db = createIdentityDatabase(env.IDENTITY_DB);
  });

  it("確認済み同士は当然弾かれる", async () => {
    await insertUser(aUser({ email: SHARED, emailVerified: true }));

    await expectUniqueViolation(() => insertUser(aUser({ email: SHARED, emailVerified: true })));
  });

  it("**未確認**でも弾かれる —— ここを partial にしてはいけない", async () => {
    // `user_emails` 側と同じ `WHERE verified_at IS NOT NULL` を付けたくなるが、
    // `users` 側では別の意味になる。緩めた瞬間、同じアドレスの行が複数できて
    // `findByEmail()`（primary_email を引く）がどれを返すか不定になる。
    await insertUser(aUser({ email: SHARED, emailVerified: false }));

    await expectUniqueViolation(() => insertUser(aUser({ email: SHARED, emailVerified: false })));
  });

  it("凍結されたアカウントのアドレスは解放されない（#51 決定 7）", async () => {
    // これが緩むと BAN を回避できる。凍結は「行を残して無効にする」ことで
    // 表現されるので、アドレスの占有が続くのは仕様どおり。
    await insertUser(aUser({ email: SHARED, status: "suspended" }));

    await expectUniqueViolation(() => insertUser(aUser({ email: SHARED })));
  });

  it("論理削除されたアカウントのアドレスも解放されない", async () => {
    // 再利用可否は #51 で「解放しない」に決まっている。ここを緩めるのは
    // 仕様の変更であって、索引だけを直す話ではない。
    await insertUser(
      aUser({ email: SHARED, status: "deleted", deletedAt: new Date("2026-01-01T00:00:00.000Z") }),
    );

    await expectUniqueViolation(() => insertUser(aUser({ email: SHARED })));
  });

  it("大文字小文字を無視して判定される", async () => {
    await insertUser(aUser({ email: SHARED }));

    await expectUniqueViolation(() => insertUser(aUser({ email: SHARED.toUpperCase() })));
  });
});

/**
 * `user_emails` は**まだどこからも書かれていない**。
 *
 * スキーマのコメントは `user_emails` を「正本」と書いているが、実際に
 * 書き込む経路は存在しない（`DrizzleUserRepository.create()` も
 * `markEmailVerified()` も `users` しか触らない）。つまり #60 で入れた
 * partial 索引は**空のテーブルを守っている**状態で、現在のメール一意性は
 * すべて `users_primary_email_unique` が担っている。
 *
 * このテストは「書かれていないこと」を固定する。`user_emails` を書く経路を
 * 足した人はここで落ちるので、そのときに次を決め直すことになる:
 *
 *  - `users` 側は無条件、`user_emails` 側は確認済みのみ。**未確認の
 *    `primary_email` が他人の登録を妨げる**という非対称がそこで表に出る
 *  - 現在の signup 経路は `emailVerified: true` でユーザーを作るので
 *    その窓は開いていないが、「未確認のまま仮登録する」経路を足した瞬間に開く
 */
describe("user_emails を書く経路はまだ無い（#62 の前提）", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("ユーザーを作っても user_emails に行は増えない", async () => {
    const db = createIdentityDatabase(env.IDENTITY_DB);
    const repo = new DrizzleUserRepository(db);
    const fixture = aUser();

    const created = await repo.create({
      id: fixture.id,
      username: fixture.username,
      displayName: fixture.displayName,
      email: fixture.email,
      emailVerified: true,
    });
    await repo.markEmailVerified(created.id, fixture.email);

    const row = await db
      .select({ count: sql<number>`count(*)` })
      .from(userEmails)
      .get();

    expect(row?.count, "user_emails を書く経路が入った。上の doc コメントの決め直しが要る").toBe(0);
  });
});

/**
 * 凍結アカウントのアドレスで signup を試みたときの応答（#62 受け入れ条件）。
 *
 * 懸念は「一意制約違反がそのまま 500 として出て、しかもそれ自体が
 * 『このアドレスは登録済み』という列挙の手掛かりになる」ことだった。
 * 実際には `StartEmailOtpUseCase` が手前で止めるので、**OTP が発行されず
 * `users.create()` まで到達しない**。その性質をここで固定する。
 *
 * ただしこれは**送信側の判断に依存した安全性**である。`shouldSend` の条件を
 * 変えれば窓は開く。検証側にも同じ畳み込みが要るのはそのためで、そちらは
 * #94 で塞がれている（`VerifyEmailOtpUseCase` が `IssueSessionUseCase` の
 * `forbidden` を `invalid_code` に畳む）。**2 つで 1 組**であり、片方だけでは
 * start と verify の間に凍結されたアカウントの状態が応答から読み取れる。
 */
describe("凍結アカウントのアドレスでの signup", () => {
  const FROZEN = "frozen@example.com";

  function setup() {
    const users = new InMemoryUserRepository();
    const challenges = new InMemoryEmailChallengeRepository();
    const audit = new RecordingAuditLogger();
    const emailSender = new RecordingEmailSender();

    return {
      users,
      emailSender,
      start: new StartEmailOtpUseCase({
        users,
        challenges,
        email: emailSender,
        hasher: new FakeHasher(),
        tokens: new WebCryptoTokenGenerator(),
        clock: new FixedClock(new Date("2026-10-24T00:00:00.000Z")),
        audit,
      }),
    };
  }

  it("OTP を送らないので users.create() まで到達しない", async () => {
    const ctx = setup();
    ctx.users.seed(aUser({ email: FROZEN, status: "suspended" }));

    const result = await ctx.start.execute({ email: FROZEN, purpose: "signup" });

    expect(result.ok).toBe(true);
    // 送らない＝コードを受け取れない＝VerifyEmailOtpUseCase を通れない。
    // 一意制約違反の 500 はここで構造的に起こりえない。
    expect(ctx.emailSender.sent).toHaveLength(0);
  });

  it("応答は未登録アドレスのときと同一", async () => {
    // 差がつくと、このエンドポイントが「凍結アカウントが存在するか」を
    // 調べる道具になる。凍結の事実は本人以外に漏らさない。
    const ctx = setup();
    ctx.users.seed(aUser({ email: FROZEN, status: "suspended" }));

    const frozen = await ctx.start.execute({ email: FROZEN, purpose: "signup" });
    const unknown = await ctx.start.execute({ email: "nobody@example.com", purpose: "signup" });

    expect(frozen).toEqual(unknown);
  });

  it("凍結アカウントは login の OTP も受け取れない", async () => {
    const ctx = setup();
    ctx.users.seed(aUser({ email: FROZEN, status: "suspended" }));

    const result = await ctx.start.execute({ email: FROZEN, purpose: "login" });

    expect(result.ok).toBe(true);
    expect(ctx.emailSender.sent).toHaveLength(0);
  });
});
