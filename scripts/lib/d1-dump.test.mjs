import assert from "node:assert/strict";
import { test } from "node:test";
import { reorderDump } from "./d1-dump.mjs";

/**
 * `wrangler d1 export` の出力を模した断片（#164）。
 *
 * **壊れていた条件そのものを入力に持たせる。** 本物のダンプは
 * テーブルごとに `CREATE TABLE` と `INSERT` を交互に並べ、順序は
 * アルファベット順なので `user_emails` が `users` より先に来る。
 * 子の `INSERT` が親の `CREATE TABLE` より前に出るのが原因だった。
 *
 * **子テーブルに行が無いと再現しない。** 問題の `INSERT` 自体が
 * 生成されないためで、空の断片でテストを書くと素通りする。
 * `user_emails` には必ず行を入れておくこと。
 */
const DUMP = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT UNIQUE
);
INSERT INTO "d1_migrations" ("id","name") VALUES(1,'0000_init.sql');
CREATE TABLE \`audit_logs\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`metadata\` text
);
INSERT INTO "audit_logs" ("id","metadata") VALUES('aud_1','{"note":"line one
line two"}');
CREATE TABLE \`user_emails\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`user_id\` text NOT NULL,
	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE cascade
);
INSERT INTO "user_emails" ("id","user_id") VALUES('uem_1','usr_1');
CREATE TABLE \`users\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`username\` text NOT NULL
);
INSERT INTO "users" ("id","username") VALUES('usr_1','alice');
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',1);
CREATE UNIQUE INDEX \`users_username_unique\` ON \`users\` (\`username\`);
CREATE INDEX \`user_emails_user_idx\` ON \`user_emails\` (\`user_id\`);
`;

/** 行頭が文の開始に見える位置のうち、`pattern` に当たる最初の添字。 */
function indexOf(lines, pattern) {
  const at = lines.findIndex((line) => pattern.test(line));
  assert.notEqual(at, -1, `見つからない: ${pattern}`);
  return at;
}

function linesOf(sql) {
  return sql.split("\n");
}

test("入力そのものが壊れた並びである（これが崩れるとテストが無意味になる）", () => {
  const lines = linesOf(DUMP);
  assert.ok(
    indexOf(lines, /^INSERT INTO "user_emails"/) < indexOf(lines, /^CREATE TABLE `users`/),
    "子の INSERT が親の CREATE TABLE より前に無い。断片が #164 を再現していない",
  );
});

test("すべての INSERT が、対応する CREATE TABLE より後にある", () => {
  const lines = linesOf(reorderDump(DUMP));
  for (const table of ["d1_migrations", "audit_logs", "user_emails", "users"]) {
    const created = indexOf(lines, new RegExp(`^CREATE TABLE(?: IF NOT EXISTS)? [\`"]?${table}`));
    const inserted = indexOf(lines, new RegExp(`^INSERT INTO "${table}"`));
    assert.ok(created < inserted, `${table}: INSERT が CREATE TABLE より前にある`);
  }
});

test("子テーブルの INSERT が、親の CREATE TABLE より後にある（#164 そのもの）", () => {
  // これが #164 の失敗条件。元のダンプでは `INSERT INTO "user_emails"` が
  // `CREATE TABLE users` より前に出るため、外部キーの親が存在しない時点で
  // 子へ入れることになり `no such table: main.users` で全体が落ちた。
  //
  // 自テーブルの CREATE TABLE との前後だけを見ても**素通りする** ——
  // 元のダンプでもテーブルごとには CREATE → INSERT の順になっている。
  const lines = linesOf(reorderDump(DUMP));
  assert.ok(
    indexOf(lines, /^CREATE TABLE `users`/) < indexOf(lines, /^INSERT INTO "user_emails"/),
    "親の CREATE TABLE より前に子の INSERT がある",
  );
});

test("子テーブルの CREATE TABLE が、親の CREATE TABLE より後にある", () => {
  const lines = linesOf(reorderDump(DUMP));
  assert.ok(
    indexOf(lines, /^CREATE TABLE `users`/) < indexOf(lines, /^CREATE TABLE `user_emails`/),
    "users が user_emails より後にある。トポロジカルソートが効いていない",
  );
});

test("sqlite_sequence への文が、すべての CREATE TABLE より後にある", () => {
  // AUTOINCREMENT を持つテーブルが作られて初めて暗黙に生成されるので、
  // 先頭に置くと `no such table: sqlite_sequence` で落ちる。
  const lines = linesOf(reorderDump(DUMP));
  const lastCreate = lines.reduce((at, line, i) => (/^CREATE TABLE/.test(line) ? i : at), -1);
  assert.ok(lastCreate > -1);
  assert.ok(indexOf(lines, /^DELETE FROM sqlite_sequence/) > lastCreate);
  assert.ok(indexOf(lines, /^INSERT INTO "sqlite_sequence"/) > lastCreate);
});

test("CREATE INDEX が最後にある", () => {
  const lines = linesOf(reorderDump(DUMP));
  const firstIndex = indexOf(lines, /^CREATE (?:UNIQUE )?INDEX/);
  const lastRow = lines.reduce(
    (at, line, i) => (/^(?:INSERT INTO|DELETE FROM)/.test(line) ? i : at),
    -1,
  );
  assert.ok(firstIndex > lastRow, "CREATE INDEX より後に行の操作が残っている");
});

test("値の中の改行で文が切れない", () => {
  // `audit_logs.metadata` は JSON。`wrangler d1 export` がリテラルな
  // 改行を出した場合、行頭キーワードで分割する実装が文の途中で切る
  // 可能性がある。継続行（`line two"}');`）が独立した文になっていない
  // ことを、INSERT の本数で見る。
  const out = reorderDump(DUMP);
  const inserts = out.split("\n").filter((line) => /^INSERT INTO "audit_logs"/.test(line));
  assert.equal(inserts.length, 1);
  assert.ok(out.includes("line two\"}');"), "継続行が落ちている");
});

test("文が 1 つも失われない", () => {
  const count = (sql) =>
    sql.split("\n").filter((line) => /^(PRAGMA|CREATE|INSERT|DELETE|DROP|UPDATE)\b/.test(line))
      .length;
  assert.equal(count(reorderDump(DUMP)), count(DUMP));
});
