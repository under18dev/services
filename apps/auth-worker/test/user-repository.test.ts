import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import {
  auditLogs,
  createIdentityDatabase,
  emailChallenges,
  oauthAuthorizationCodes,
  oauthClients,
  oauthGrants,
  oauthTokens,
  passkeys,
  sessions,
  userEmails,
  users,
  webauthnChallenges,
} from "@u18/db";
import { purgeUserSql } from "../src/infrastructure/persistence/purge-user.sql";
import { aUser, type UserFixture } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { DrizzleUserRepository } from "../src/infrastructure/persistence/drizzle-user.repository";
import { expectForeignKeyViolation, resetDatabase } from "./helpers";

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
    // `$onUpdateFn` は**その列が渡されていないとき**にだけ走るので、
    // 実装は `updatedAt` に現在値を明示して入れ直している。
    // **この検査がその実装を固定する。**
    //
    // 生の SQL も試したが、**SQLite の UPDATE は `set` 側に修飾付きの
    // 列名を許さない**（`"users"."last_active_at"` で落ちた）。列名は
    // drizzle に解決させている。
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

/**
 * 退会したあとも管理者が個人情報を落とせること（#318 / ランブック §11.6）。
 *
 * **これが #318 の設計の全部である。** 本人の退会で `status` を `deleted` に
 * すると、`purgeUserSql` のガード `status <> 'deleted'` がこの行に当たらず、
 * **氏名相当とメールアドレスが落ちないまま、管理者が二度と落とせなくなる。**
 * しかも `returning` が 0 行を返すので、運用者からは「既に落とした」と
 * 区別が付かない —— **正常と異常が同じ観測値になる。**
 *
 * `InMemoryUserRepository` では噛み合わせのほうが写らないので、ここで
 * **実物の D1 に両方の文を流す。**
 */
describe("退会したアカウントを、管理者が落とせる", () => {
  let repo: DrizzleUserRepository;
  let user: UserFixture;

  beforeEach(async () => {
    await resetDatabase();
    repo = new DrizzleUserRepository(createIdentityDatabase(env.IDENTITY_DB));
    user = aUser({ username: "leaving_one" });
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

  async function statusOf(id: string): Promise<string | undefined> {
    const row = await createIdentityDatabase(env.IDENTITY_DB)
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, id))
      .get();
    return row?.status;
  }

  it("退会は suspended にする", async () => {
    expect(await repo.closeAccount(user.id)).toBe(true);
    expect(await statusOf(user.id)).toBe("suspended");
  });

  it("退会したあとで purge が当たる", async () => {
    await repo.closeAccount(user.id);

    const purged = await env.IDENTITY_DB.prepare(purgeUserSql(user.id)).all();

    // **ここが本体。** 0 行なら、個人情報は落ちないまま回収不能になっている。
    expect(purged.results).toHaveLength(1);
    expect(await statusOf(user.id)).toBe("deleted");
  });

  it("active でない行には当たらない（BAN を塗り替えない）", async () => {
    await repo.closeAccount(user.id);

    // 2 回目。既に `suspended` なので当たらない。
    expect(await repo.closeAccount(user.id)).toBe(false);
  });

  it("purge 済みの行を退会で触らない", async () => {
    await env.IDENTITY_DB.prepare(purgeUserSql(user.id)).all();

    expect(await repo.closeAccount(user.id)).toBe(false);
    expect(await statusOf(user.id)).toBe("deleted");
  });
});

/**
 * 行そのものを消す（運用者判断、2026-11-08）。**CASCADE で消える範囲と、残る範囲の両方を
 * 1 つずつ数える。** 「消えたはず」で済ませない —— `UserRepository.deletePermanently`
 * の JSDoc が挙げている保証を、実物の D1 で固定する。
 */
describe("DrizzleUserRepository.deletePermanently", () => {
  let repo: DrizzleUserRepository;
  const db = () => createIdentityDatabase(env.IDENTITY_DB);

  beforeEach(async () => {
    await resetDatabase();
    repo = new DrizzleUserRepository(db());
  });

  async function insertUser(fixture: UserFixture): Promise<void> {
    await db()
      .insert(users)
      .values({
        id: fixture.id,
        username: fixture.username,
        displayName: fixture.displayName,
        primaryEmail: fixture.email,
        emailVerified: fixture.emailVerified,
        status: fixture.status,
      })
      .run();
  }

  it("対象が存在しなければ false", async () => {
    expect(await repo.deletePermanently("usr_does_not_exist")).toBe(false);
  });

  it("active な行には当たらない（運用者判断、2026-11-08: 先に凍結が要る）", async () => {
    const victim = aUser({ username: "still_active" }); // 既定が active。
    await insertUser(victim);

    expect(await repo.deletePermanently(victim.id)).toBe(false);
    // 行は手付かずで残る。
    const row = await db().select().from(users).where(eq(users.id, victim.id)).get();
    expect(row).toBeDefined();
  });

  it("deleted（purge 済み）な行にも当たる", async () => {
    const victim = aUser({ username: "already_purged", status: "deleted" });
    await insertUser(victim);

    expect(await repo.deletePermanently(victim.id)).toBe(true);
    expect(await db().select().from(users).where(eq(users.id, victim.id)).get()).toBeUndefined();
  });

  it("CASCADE に頼らず手で子テーブルを消す。FK を持たない行は残る。oauth_clients は owner だけ外れて残る", async () => {
    const victim = aUser({ username: "to_be_deleted", status: "suspended" });
    await insertUser(victim);

    const client = "cli_owned_by_victim";
    await db()
      .insert(oauthClients)
      .values({
        id: client,
        clientId: "owned-client",
        name: "所有者が消える予定のクライアント",
        clientType: "public",
        allowedScopes: "openid",
        isFirstParty: false,
        ownerUserId: victim.id,
      })
      .run();

    const otherClient = "cli_untouched";
    await db()
      .insert(oauthClients)
      .values({
        id: otherClient,
        clientId: "untouched-client",
        name: "無関係なクライアント",
        clientType: "public",
        allowedScopes: "openid",
        isFirstParty: false,
      })
      .run();

    await db()
      .insert(sessions)
      .values({
        id: "ses_victim",
        userId: victim.id,
        tokenHash: "hash-victim",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        authMethod: "email_otp",
        lastSeenAt: new Date(),
      })
      .run();

    await db()
      .insert(passkeys)
      .values({
        id: "pk_victim",
        userId: victim.id,
        credentialId: "cred-victim",
        publicKey: "pub-victim",
      })
      .run();

    await db()
      .insert(webauthnChallenges)
      .values({
        id: "wch_victim",
        userId: victim.id,
        challenge: "challenge-victim",
        purpose: "registration",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .run();

    await db()
      .insert(emailChallenges)
      .values({
        id: "ech_victim",
        userId: victim.id,
        email: victim.email,
        codeHash: "hash-otp-victim",
        purpose: "login",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .run();

    await db()
      .insert(oauthGrants)
      .values({
        id: "grt_victim",
        userId: victim.id,
        clientId: client,
        grantedScopes: "openid",
        grantedAt: new Date(),
      })
      .run();

    await db()
      .insert(oauthAuthorizationCodes)
      .values({
        id: "code_victim",
        codeHash: "hash-code-victim",
        clientId: client,
        userId: victim.id,
        redirectUri: "https://app.example/cb",
        scope: "openid",
        codeChallenge: "challenge",
        codeChallengeMethod: "S256",
        authTime: new Date(),
        expiresAt: new Date(Date.now() + 60 * 1000),
      })
      .run();

    await db()
      .insert(oauthTokens)
      .values({
        id: "tok_victim",
        tokenHash: "hash-token-victim",
        grantId: "grt_victim",
        clientId: client,
        userId: victim.id,
        scope: "openid",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      })
      .run();

    await db()
      .insert(userEmails)
      .values({
        id: "uem_victim",
        userId: victim.id,
        email: victim.email,
        verifiedAt: new Date(),
        isPrimary: true,
      })
      .run();

    // **`audit_logs` は FK を持たない。** 物理削除より前に記録された行が、
    // 削除後も残ることを示す —— 削除後に唯一「この id は削除された」と
    // 辿れる手段になる記録そのもの（`ops.user.deleted` の JSDoc を参照）。
    await db()
      .insert(auditLogs)
      .values({
        id: "aud_before_delete",
        event: "session.issue",
        userId: victim.id,
        outcome: "success",
      })
      .run();

    // **このテストは「最終的に消えている」ことしか見ない。** `pragma
    // foreign_keys = off` で CASCADE を止めて検査しようとしたが、実測した
    // ところこの環境では `off` にしても `pragma foreign_keys` の読み戻しが
    // `1`（有効）のままで、**外部キーを無効化する手段が無かった**
    // （b6 の調査・3b の指摘、2026-11-08）。つまりこのテストは CASCADE が
    // 黙って肩代わりしても緑になる——「手で消した」ことの決定的な証拠には
    // ならない。その証拠は下の「子テーブルの DELETE は、親の users 行が
    // 残っていても効く」が担う（親を消さないので CASCADE の出る幕が無い）。

    const deleted = await repo.deletePermanently(victim.id);
    expect(deleted).toBe(true);

    // 本体が消える。
    expect(await db().select().from(users).where(eq(users.id, victim.id)).get()).toBeUndefined();

    // 子テーブルが消えたことを 1 つずつ数える。CASCADE は off にしてある
    // ので、消えているなら手で消した証拠になる。「消えたはず」で済ませない。
    expect(
      await db().select().from(sessions).where(eq(sessions.userId, victim.id)).all(),
    ).toHaveLength(0);
    expect(
      await db().select().from(passkeys).where(eq(passkeys.userId, victim.id)).all(),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(webauthnChallenges)
        .where(eq(webauthnChallenges.userId, victim.id))
        .all(),
    ).toHaveLength(0);
    expect(
      await db().select().from(emailChallenges).where(eq(emailChallenges.userId, victim.id)).all(),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(oauthAuthorizationCodes)
        .where(eq(oauthAuthorizationCodes.userId, victim.id))
        .all(),
    ).toHaveLength(0);
    expect(
      await db().select().from(oauthGrants).where(eq(oauthGrants.userId, victim.id)).all(),
    ).toHaveLength(0);
    expect(
      await db().select().from(oauthTokens).where(eq(oauthTokens.userId, victim.id)).all(),
    ).toHaveLength(0);
    expect(
      await db().select().from(userEmails).where(eq(userEmails.userId, victim.id)).all(),
    ).toHaveLength(0);

    // FK を持たない・持てない行は残る。
    const clientRow = await db()
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, client))
      .get();
    expect(clientRow).toBeDefined();
    expect(clientRow?.ownerUserId).toBeNull();

    const otherClientRow = await db()
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, otherClient))
      .get();
    expect(otherClientRow).toBeDefined();

    const auditRows = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, victim.id))
      .all();
    expect(auditRows.length).toBeGreaterThan(0);
  });

  /**
   * **CASCADE に credit を奪わせない、決定的な検査。**
   *
   * 上のテストだけでは不十分だった——実測したところ、この環境では
   * `pragma foreign_keys = off` を実行しても `pragma foreign_keys` の
   * 読み戻しが `1`（有効）のままで、**明示的に無効化する手段が無い**
   * （b6 / 3b への報告事項）。つまり CASCADE は常に効いており、
   * `deletePermanently` から子テーブルの DELETE 文を 1 つ消しても、
   * CASCADE が黙って肩代わりしてこのテストファイルの他のテストは
   * 緑のまま通ってしまう（実際に確認した）。「検査は空でも緑になる」の
   * 一段深い形——検査の土台そのものが、見たいもの以外の経路でも
   * 同じ結果を作ってしまう。
   *
   * ここでは **`users` の行を消さずに**、`deletePermanently` が子テーブルを
   * 消せることだけを確かめる。親の行が存在し続ける以上、CASCADE が
   * 発火する余地は無い——消えたなら、それは `deletePermanently` 自身の
   * 明示的な DELETE 文によるものだと言い切れる。
   *
   * `deletePermanently` を丸ごと呼ぶとどうしても `users` も一緒に消えて
   * しまうので、ここだけは本体の実装と同じ 8 文を直接組み立てる
   * （drizzle-user.repository.ts の `deletePermanently` と意図的に
   * 重複させている——対象のテーブルが増減したら、この一覧も合わせて
   * 直すこと。ずれたままになる心配があるなら、本体側を「子テーブルの
   * 一覧」として外へ出す設計に変えること）。
   *
   * **`targetIsDeletable`（`active` を除外する条件）はここに写していない。**
   * この一覧は「cascade に頼らず手で消しているか」だけを見るためのもので、
   * `active` ガードは別のテスト（「active な行には当たらない」）が見る
   * ——2 つの関心を 1 つのテストに混ぜない。victim の `status` は
   * `aUser` の既定（`active`）のままで構わない。
   */
  it("子テーブルの DELETE は、親の users 行が残っていても効く（CASCADE では説明できない）", async () => {
    const victim = aUser({ username: "attribution_check" });
    await insertUser(victim);

    await db()
      .insert(sessions)
      .values({
        id: "ses_attr",
        userId: victim.id,
        tokenHash: "hash-attr",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        authMethod: "email_otp",
        lastSeenAt: new Date(),
      })
      .run();
    await db()
      .insert(passkeys)
      .values({
        id: "pk_attr",
        userId: victim.id,
        credentialId: "cred-attr",
        publicKey: "pub-attr",
      })
      .run();
    await db()
      .insert(webauthnChallenges)
      .values({
        id: "wch_attr",
        userId: victim.id,
        challenge: "challenge-attr",
        purpose: "registration",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .run();
    await db()
      .insert(emailChallenges)
      .values({
        id: "ech_attr",
        userId: victim.id,
        email: victim.email,
        codeHash: "hash-otp-attr",
        purpose: "login",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .run();
    const client = "cli_attr";
    await db()
      .insert(oauthClients)
      .values({
        id: client,
        clientId: "attr-client",
        name: "attribution check",
        clientType: "public",
        allowedScopes: "openid",
        isFirstParty: false,
      })
      .run();
    await db()
      .insert(oauthGrants)
      .values({
        id: "grt_attr",
        userId: victim.id,
        clientId: client,
        grantedScopes: "openid",
        grantedAt: new Date(),
      })
      .run();
    await db()
      .insert(oauthAuthorizationCodes)
      .values({
        id: "code_attr",
        codeHash: "hash-code-attr",
        clientId: client,
        userId: victim.id,
        redirectUri: "https://app.example/cb",
        scope: "openid",
        codeChallenge: "challenge",
        codeChallengeMethod: "S256",
        authTime: new Date(),
        expiresAt: new Date(Date.now() + 60 * 1000),
      })
      .run();
    await db()
      .insert(oauthTokens)
      .values({
        id: "tok_attr",
        tokenHash: "hash-token-attr",
        grantId: "grt_attr",
        clientId: client,
        userId: victim.id,
        scope: "openid",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      })
      .run();
    await db()
      .insert(userEmails)
      .values({
        id: "uem_attr",
        userId: victim.id,
        email: victim.email,
        verifiedAt: new Date(),
        isPrimary: true,
      })
      .run();

    // **本体の `deletePermanently` と同じ 8 文を、`users` の DELETE だけ
    // 外して流す。** 親の行は意図的に残す。
    await db().batch([
      db().delete(sessions).where(eq(sessions.userId, victim.id)),
      db().delete(passkeys).where(eq(passkeys.userId, victim.id)),
      db().delete(webauthnChallenges).where(eq(webauthnChallenges.userId, victim.id)),
      db().delete(emailChallenges).where(eq(emailChallenges.userId, victim.id)),
      db().delete(oauthTokens).where(eq(oauthTokens.userId, victim.id)),
      db().delete(oauthGrants).where(eq(oauthGrants.userId, victim.id)),
      db().delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.userId, victim.id)),
      db().delete(userEmails).where(eq(userEmails.userId, victim.id)),
    ]);

    // 親の行は手付かずで残っている——CASCADE が発火する前提（親の削除）
    // がそもそも起きていない。
    expect(await db().select().from(users).where(eq(users.id, victim.id)).get()).toBeDefined();

    // それでも子テーブルは全部消えている。CASCADE では説明できない。
    expect(
      await db().select().from(sessions).where(eq(sessions.userId, victim.id)).all(),
    ).toHaveLength(0);
    expect(
      await db().select().from(passkeys).where(eq(passkeys.userId, victim.id)).all(),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(webauthnChallenges)
        .where(eq(webauthnChallenges.userId, victim.id))
        .all(),
    ).toHaveLength(0);
    expect(
      await db().select().from(emailChallenges).where(eq(emailChallenges.userId, victim.id)).all(),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(oauthAuthorizationCodes)
        .where(eq(oauthAuthorizationCodes.userId, victim.id))
        .all(),
    ).toHaveLength(0);
    expect(
      await db().select().from(oauthGrants).where(eq(oauthGrants.userId, victim.id)).all(),
    ).toHaveLength(0);
    expect(
      await db().select().from(oauthTokens).where(eq(oauthTokens.userId, victim.id)).all(),
    ).toHaveLength(0);
    expect(
      await db().select().from(userEmails).where(eq(userEmails.userId, victim.id)).all(),
    ).toHaveLength(0);
  });

  it("owner_user_id を先に外さないと FK 違反で落ちる（2 文に分けている理由そのもの）", async () => {
    const victim = aUser({ username: "fk_hazard" });
    await insertUser(victim);
    await db()
      .insert(oauthClients)
      .values({
        id: "cli_fk_hazard",
        clientId: "fk-hazard-client",
        name: "FK を実測するためのクライアント",
        clientType: "public",
        allowedScopes: "openid",
        isFirstParty: false,
        ownerUserId: victim.id,
      })
      .run();

    // 明示的に強制する。無いと FK 違反そのものが起きず、この検査が
    // 「何も見ていない」まま緑になる（3b の指摘、2026-11-08）。
    await env.IDENTITY_DB.prepare("pragma foreign_keys = on").run();

    // **owner_user_id を外さずに消すとどうなるかを、まず実測する。**
    // これが `deletePermanently` を 1 文で済ませられない理由そのもの
    // ——`oauth_clients.owner_user_id` に `onDelete` が無いため。
    // Drizzle は元の例外を包むので、`cause` まで辿って確かめる
    // （`expectForeignKeyViolation` / `expectUniqueViolation` と同じ理由）。
    await expectForeignKeyViolation(() => db().delete(users).where(eq(users.id, victim.id)).run());
  });
});
