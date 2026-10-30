import assert from "node:assert/strict";
import test from "node:test";
import { reorderDump } from "./d1-dump.mjs";
import { countInsertsByTable, rehearseRestore, REQUIRED_TABLES } from "./restore-rehearsal.mjs";

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

// --- ダンプの件数と流し込み後の行数の突き合わせ（#325） -----------------------

test("INSERT の件数をテーブルごとに数える", () => {
  assert.deepEqual(countInsertsByTable(ORDERED), { users: 1, user_emails: 1 });
});

test("sqlite_ で始まる内部表は数えない", () => {
  const sql = `${ORDERED}\nINSERT INTO sqlite_sequence VALUES ('users', 1);`;
  assert.deepEqual(countInsertsByTable(sql), { users: 1, user_emails: 1 });
});

test("件数が一致すれば通る", async () => {
  const expectedRows = countInsertsByTable(ORDERED);
  const result = await rehearseRestore(reorderDump(ORDERED), { expectedRows });
  assert.deepEqual(result.problems, []);
});

test("★空のダンプでも、0 件同士で一致すれば件数の検査は通る", async () => {
  // **閾値を置かずに済む**のがこの方式の肝。カードが正当に 0 件でも偽陽性にしない。
  const result = await rehearseRestore(reorderDump(EMPTY), {
    expectedRows: countInsertsByTable(EMPTY),
    requireRows: [],
  });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.tables, { user_emails: 0, users: 0 });
});

test("★文が流れなかったら件数のずれとして出る", async () => {
  // ダンプには 2 件あるのに、流し込む側から 1 件落とす。
  // **これが #165 の形そのもの** —— 流し込みは成功するのに中身が足りない。
  const dump = `
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
CREATE TABLE user_emails (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
INSERT INTO users VALUES ('u1', 'a@example.test');
INSERT INTO users VALUES ('u2', 'b@example.test');
`;
  const expectedRows = countInsertsByTable(dump);
  assert.deepEqual(expectedRows, { users: 2 });

  const dropped = dump.replace("INSERT INTO users VALUES ('u2', 'b@example.test');\n", "");
  const result = await rehearseRestore(reorderDump(dropped), { expectedRows, requireRows: [] });

  assert.equal(result.ok, false);
  assert.match(
    result.problems.join("\n"),
    /users の件数が合わない: ダンプに 2 件 \/ 流し込み後 1 件/,
  );
  // **流し込み自体は成功している。** だから件数を見ないと気づけない。
  assert.equal(result.statementError, null);
});

test("ダンプにあるテーブルが作られていなければ落ちる", async () => {
  const result = await rehearseRestore("CREATE TABLE users (id TEXT PRIMARY KEY);", {
    expectedRows: { cards: 3 },
    requireRows: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /cards へ 3 件入るはずが、テーブルが存在しない/);
});

test("件数の中身はエラーに出すが、行の値は出さない", async () => {
  const dump = `
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
INSERT INTO users VALUES ('u1', 'taro@example.test');
`;
  const result = await rehearseRestore("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);", {
    expectedRows: countInsertsByTable(dump),
    requireRows: [],
  });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.problems.join("\n"), /example\.test/);
});
