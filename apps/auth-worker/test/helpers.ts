import { env } from "cloudflare:test";
import {
  createIdentityDatabase,
  emailChallenges,
  oauthAuthorizationCodes,
  oauthClients,
  oauthGrants,
  oauthTokens,
  passkeys,
  sessions,
  userEmails,
  webauthnChallenges,
} from "@u18/db";
import { eq } from "drizzle-orm";
import { expect } from "vitest";

/**
 * テーブルを空にする。
 *
 * マイグレーションは setup.ts で一度だけ適用済みなので、ここでは行だけを消す。
 * d1_migrations / 内部テーブルは残す。
 */
export async function resetDatabase(): Promise<void> {
  const tables = await env.IDENTITY_DB.prepare(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '_cf_%' and name not like 'd1_%'",
  ).all<{ name: string }>();

  // テーブル間に依存は無いので同時に消す。FK は ON DELETE CASCADE なので
  // 順序に意味が無く、直列にしても得られるものが無い。
  await Promise.all(
    tables.results.map(({ name }) => env.IDENTITY_DB.exec(`delete from "${name}"`)),
  );
}

/**
 * 一意制約違反で落ちたことを確かめる。
 *
 * Drizzle は元の例外を「Failed query: ...」で包むので、SQLite の
 * メッセージは `cause` 側にしか出てこない。単に throw したことだけを
 * 見ると、別の理由（FK 違反など）で落ちていても通ってしまう。
 */
export async function expectUniqueViolation(run: () => Promise<unknown>): Promise<void> {
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

/**
 * 外部キー違反で落ちたことを確かめる。**`expectUniqueViolation` と同じ
 * 理由で `cause` を辿る。** 「`delete` が落ちた」ことだけを見ると、
 * 無関係な理由（NOT NULL 違反など）で落ちていても通ってしまう。
 */
export async function expectForeignKeyViolation(run: () => Promise<unknown>): Promise<void> {
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
  expect(messages.join(" / ")).toMatch(/FOREIGN KEY constraint failed/i);
}

/**
 * レート制限の窓の**境界を跨がない**位置から始める（#176）。
 *
 * ## なぜ要るのか
 *
 * Cloudflare の Rate Limiting は**壁時計に揃った固定窓**で、
 * `epoch = floor(now / period)` で数える。全キーが**同じ瞬間に一斉に
 * リセットされる**。
 *
 * 「上限まで送ってから 1 本余計に送る」形のテストは、その途中で窓が
 * 切り替わるとカウンタが 0 に戻り、**最後の 1 本が通ってしまう。**
 * 実装は正しいのにテストだけが落ちる。
 *
 * ## なぜ共有の場所に置いてあるか
 *
 * **ランブック §13.2 は「別のファイルで同じ形を書くときは同じ手当てが
 * 要る」と書いているが、手当てそのものは `rate-limit.test.ts` の中に
 * 閉じていた。** 書いてある指示に従おうとしても、**コピーするしか
 * なかった**。実際 `rate-limit-form.test.ts`（#232）は手当て無しで
 * 入り、CI で `expected 200 to be 429` として出た。
 *
 * 指示を守れる形にしないと、指示は守られない。
 *
 * > **文書に「気をつけて」と書く形は守られない。`import` すれば効く場所に
 * > 置けば、次に書く人は何も覚えていなくてよい。**（#253）
 *
 * ## `marginMs` を呼び出し側が決める
 *
 * 必要な余裕は**そのファイルの 1 件がどれだけ時間を食うか**で決まる。
 *
 * | 呼び出し側                | 1 件の実測              |
 * | ------------------------- | ----------------------- |
 * | `rate-limit.test.ts`      | バースト 20 本で 21ms   |
 * | `rate-limit-form.test.ts` | 1 件 78ms（CI で 398ms）|
 *
 * **CI は手元より 5 倍遅い。** 既定の 1 秒は前者には十分だが、後者には
 * 足りない —— 398ms は 1 秒の 4 割で、もう少し遅い日に跨ぐ。
 * 既定を全体に合わせて広げると、速いファイルが毎回無駄に待つので、
 * **使う側が自分の実測から決める。**
 */
export async function startOfRateLimitWindow(
  periodSeconds: number,
  marginMs = 1_000,
): Promise<void> {
  const period = periodSeconds * 1_000;
  const remaining = period - (Date.now() % period);
  if (remaining >= marginMs) return;
  await new Promise((resolve) => setTimeout(resolve, remaining + 50));
}

/**
 * `deletePermanently` が手で消す 8 つの子テーブルに 1 行ずつ、加えて
 * `owner_user_id` で持ち主を指す `oauth_clients` を 1 行入れる。
 *
 * **対象のテーブルが増減したら、ここと `countUserChildRows` も合わせて
 * 直すこと。** 「子テーブルが残る/消える」を確かめるテストはどれも
 * この 2 つを通すので、一覧が 1 箇所にまとまっている。
 *
 * `tag` は id や一意な列の衝突を避けるための接尾辞。
 */
export async function seedUserChildRows(
  userId: string,
  email: string,
  tag: string,
): Promise<{ readonly ownedClientId: string }> {
  const db = createIdentityDatabase(env.IDENTITY_DB);
  const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000);
  const ownedClientId = `cli_owned_${tag}`;

  await db
    .insert(oauthClients)
    .values({
      id: ownedClientId,
      clientId: `owned-client-${tag}`,
      name: `持ち主が ${tag} のクライアント`,
      clientType: "public",
      allowedScopes: "openid",
      isFirstParty: false,
      ownerUserId: userId,
    })
    .run();
  await db
    .insert(sessions)
    .values({
      id: `ses_${tag}`,
      userId,
      tokenHash: `hash-session-${tag}`,
      expiresAt: inAnHour(),
      authMethod: "email_otp",
      lastSeenAt: new Date(),
    })
    .run();
  await db
    .insert(passkeys)
    .values({
      id: `pk_${tag}`,
      userId,
      credentialId: `cred-${tag}`,
      publicKey: `pub-${tag}`,
    })
    .run();
  await db
    .insert(webauthnChallenges)
    .values({
      id: `wch_${tag}`,
      userId,
      challenge: `challenge-${tag}`,
      purpose: "registration",
      expiresAt: inAnHour(),
    })
    .run();
  await db
    .insert(emailChallenges)
    .values({
      id: `ech_${tag}`,
      userId,
      email,
      codeHash: `hash-otp-${tag}`,
      purpose: "login",
      expiresAt: inAnHour(),
    })
    .run();
  await db
    .insert(oauthGrants)
    .values({
      id: `grt_${tag}`,
      userId,
      clientId: ownedClientId,
      grantedScopes: "openid",
      grantedAt: new Date(),
    })
    .run();
  await db
    .insert(oauthAuthorizationCodes)
    .values({
      id: `code_${tag}`,
      codeHash: `hash-code-${tag}`,
      clientId: ownedClientId,
      userId,
      redirectUri: "https://app.example/cb",
      scope: "openid",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      authTime: new Date(),
      expiresAt: new Date(Date.now() + 60 * 1000),
    })
    .run();
  await db
    .insert(oauthTokens)
    .values({
      id: `tok_${tag}`,
      tokenHash: `hash-token-${tag}`,
      grantId: `grt_${tag}`,
      clientId: ownedClientId,
      userId,
      scope: "openid",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    })
    .run();
  await db
    .insert(userEmails)
    .values({
      id: `uem_${tag}`,
      userId,
      email,
      verifiedAt: new Date(),
      isPrimary: true,
    })
    .run();

  return { ownedClientId };
}

/**
 * `userId` を指す子テーブルの行数と、持ち主として `userId` を指す
 * `oauth_clients` の行数を、テーブルごとに数える。
 *
 * まとめて 1 つの数にしない——どのテーブルが残った/消えたのかが、
 * 落ちたときの差分にそのまま出るようにする。
 */
export async function countUserChildRows(userId: string): Promise<Record<string, number>> {
  const db = createIdentityDatabase(env.IDENTITY_DB);
  const count = async (rows: Promise<unknown[]>): Promise<number> => (await rows).length;
  return {
    sessions: await count(db.select().from(sessions).where(eq(sessions.userId, userId)).all()),
    passkeys: await count(db.select().from(passkeys).where(eq(passkeys.userId, userId)).all()),
    webauthn_challenges: await count(
      db.select().from(webauthnChallenges).where(eq(webauthnChallenges.userId, userId)).all(),
    ),
    email_challenges: await count(
      db.select().from(emailChallenges).where(eq(emailChallenges.userId, userId)).all(),
    ),
    oauth_tokens: await count(
      db.select().from(oauthTokens).where(eq(oauthTokens.userId, userId)).all(),
    ),
    oauth_grants: await count(
      db.select().from(oauthGrants).where(eq(oauthGrants.userId, userId)).all(),
    ),
    oauth_authorization_codes: await count(
      db
        .select()
        .from(oauthAuthorizationCodes)
        .where(eq(oauthAuthorizationCodes.userId, userId))
        .all(),
    ),
    user_emails: await count(
      db.select().from(userEmails).where(eq(userEmails.userId, userId)).all(),
    ),
    oauth_clients_owned: await count(
      db.select().from(oauthClients).where(eq(oauthClients.ownerUserId, userId)).all(),
    ),
  };
}

/** `seedUserChildRows` が入れた行が、1 つも欠けずに残っているときの数え方。 */
export const EVERY_CHILD_ROW_PRESENT = {
  sessions: 1,
  passkeys: 1,
  webauthn_challenges: 1,
  email_challenges: 1,
  oauth_tokens: 1,
  oauth_grants: 1,
  oauth_authorization_codes: 1,
  user_emails: 1,
  oauth_clients_owned: 1,
} as const;

/** 子テーブルが全部消え、`oauth_clients` の持ち主も外れたときの数え方。 */
export const NO_CHILD_ROW_LEFT = {
  sessions: 0,
  passkeys: 0,
  webauthn_challenges: 0,
  email_challenges: 0,
  oauth_tokens: 0,
  oauth_grants: 0,
  oauth_authorization_codes: 0,
  user_emails: 0,
  oauth_clients_owned: 0,
} as const;
