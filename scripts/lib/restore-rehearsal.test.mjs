import assert from "node:assert/strict";
import test from "node:test";
import { rehearseRestore, REQUIRED_TABLES } from "./restore-rehearsal.mjs";

/** 親が先。`reorderDump()` を通した後の形。 */
const ORDERED = `
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
CREATE TABLE user_emails (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
INSERT INTO users VALUES ('u1', 'a@example.test');
INSERT INTO user_emails VALUES ('e1', 'u1');
`;

/**
 * `wrangler d1 export` が実際に吐く形。**テーブルはアルファベット順**なので
 * `user_emails` が `users` より先に来る（#164 / #165）。
 */
const D1_ORDER = `
PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE user_emails (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
INSERT INTO user_emails VALUES ('e1', 'u1');
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
INSERT INTO users VALUES ('u1', 'a@example.test');
`;

/** テーブルはできるが行が無い。**本番で最初のアカウントができる前の形。** */
const EMPTY = `
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
CREATE TABLE user_emails (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
`;

test("並べ替え済みのダンプは通る", async () => {
  const result = await rehearseRestore(ORDERED);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tables, { user_emails: 1, users: 1 });
});

test("#165 の形（子の INSERT が親の CREATE より先）は落ちる", async () => {
  const result = await rehearseRestore(D1_ORDER);
  assert.equal(result.ok, false);
  // 実際の復元で出るのと同じエラー。**ここが再現しなければ検査の意味が無い。**
  assert.match(result.statementError ?? "", /no such table: main\.users/);
});

test("`PRAGMA defer_foreign_keys` には頼らない", async () => {
  // D1_ORDER は先頭にこの PRAGMA を持っている。**それでも落ちる**ことを
  // 固定する。効くと誤解したまま並べ替えを外すと、検査が素通りを始める。
  assert.match(D1_ORDER, /defer_foreign_keys=TRUE/);
  const result = await rehearseRestore(D1_ORDER);
  assert.equal(result.ok, false);
});

test("★空のデータベースは「復元できた」と認めない", async () => {
  // **この検査が無いと、#165 の形をそのまま再現したものが緑になる。**
  // 行数の一致も foreign_key_check の違反 0 も、空の DB では自動的に満たされる。
  const result = await rehearseRestore(EMPTY);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /users に行が無い/);
  assert.match(result.problems.join("\n"), /user_emails に行が無い/);
  // 流し込み自体は成功している（だから危ない）。
  assert.equal(result.statementError, null);
});

test("要求するテーブルが存在しなければ落ちる", async () => {
  const result = await rehearseRestore("CREATE TABLE cards (id TEXT PRIMARY KEY);");
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /users が存在しない/);
});

test("テーブルが 1 つも無いダンプは落ちる", async () => {
  const result = await rehearseRestore("-- 何も無い\n");
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /テーブルが 1 つも作られていない/);
});

test("外部キーの違反を検出し、行の中身は出さない", async () => {
  // 親を消してから子を入れる経路を、外部キーを一時的に切って作る。
  const orphan = `
    PRAGMA foreign_keys = OFF;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
    CREATE TABLE user_emails (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
    INSERT INTO users VALUES ('u1', 'a@example.test');
    INSERT INTO user_emails VALUES ('e1', 'missing-user');
  `;
  const result = await rehearseRestore(orphan);
  assert.equal(result.ok, false);
  const text = result.problems.join("\n");
  assert.match(text, /外部キーの違反がある/);
  assert.match(text, /user_emails/);
  // **中身は出さない。** 違反行には利用者のデータが入る。
  assert.doesNotMatch(text, /missing-user/);
  assert.doesNotMatch(text, /example\.test/);
});

test("requireRows は呼び出し側で変えられる", async () => {
  const result = await rehearseRestore(EMPTY, { requireRows: [] });
  // 行が無いことは問題にならないが、テーブルはできている。
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.tables, { user_emails: 0, users: 0 });
});

test("既定で要求するのは users と user_emails", () => {
  // #165 が「親より先に子の INSERT が来る」で壊れていた以上、
  // **この 2 つに行があることがリハーサルの前提条件**である。
  assert.deepEqual([...REQUIRED_TABLES], ["users", "user_emails"]);
});
