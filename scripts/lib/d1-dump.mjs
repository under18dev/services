/**
 * ダンプの文を、復元できる順序に並べ替える（#164）。
 *
 * ## なぜ要るのか
 *
 * `wrangler d1 export` は **テーブルごとに `CREATE TABLE` と `INSERT` を
 * 交互に**並べ、テーブルの順序はアルファベット順である。つまり
 * `user_emails` の `INSERT` が `CREATE TABLE users` より先に来る。
 * 外部キーの親が存在しない時点で子へ入れることになり、SQLite が
 * `no such table: main.users` を返して復元が丸ごと失敗する。
 *
 * ダンプ先頭の `PRAGMA defer_foreign_keys=TRUE` は効かない。**wrangler が
 * ファイルを文に分割してバッチで送るため、PRAGMA が後続の文に持続しない。**
 *
 * **子テーブルに行が無い間は通ってしまう**のが厄介なところで、問題の
 * `INSERT` 自体が生成されない。「前は動いた」が成立するので、取得した
 * ダンプを一度も流さずに運用すると、必要になった日に初めて壊れていると
 * 分かる（runbook 12.8）。
 *
 * ## 取得時ではなく復元時に並べ替える
 *
 * ダンプは Cloudflare が吐いた生の出力のまま保管する。加工して保管すると、
 * **加工側にバグがあったときに元へ戻せない。**
 */
/**
 * ダンプを文に分ける。
 *
 * 行頭が文の開始キーワードのところで区切る。D1 のダンプは 1 文が複数行に
 * またがる（`CREATE TABLE` の列定義）が、**継続行がこれらのキーワードで
 * 始まることは無い。**
 *
 * `reorderDump()` と `countInsertsByTable()`（`restore-rehearsal.mjs`）が
 * **同じ分け方を使う**ためにここへ出してある。別々に分けると、
 * 「並べ替えたもの」と「数えたもの」がずれても誰も気づかない。
 */
export function splitStatements(sql) {
  const statements = [];
  let current = [];
  const starts = /^(PRAGMA|CREATE|INSERT|DELETE|DROP|UPDATE)\b/;
  for (const line of sql.split("\n")) {
    if (starts.test(line) && current.length > 0) {
      statements.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) statements.push(current.join("\n"));
  return statements;
}

export function reorderDump(sql) {
  const statements = splitStatements(sql);

  const tableOf = /^CREATE TABLE(?: IF NOT EXISTS)? [`"]?([A-Za-z_0-9]+)/;
  const rowsOf = /^(?:INSERT INTO|DELETE FROM) [`"]?([A-Za-z_0-9]+)/;
  const parentOf = /REFERENCES [`"]?([A-Za-z_0-9]+)/g;

  const creates = new Map();
  const parents = new Map();
  const rows = new Map();
  // **catch-all である。** `CREATE` でも `INSERT INTO` / `DELETE FROM` でも
  // ない文は全部ここへ入り、出力の先頭に置かれる。`d1 export` が出すのは
  // `PRAGMA defer_foreign_keys` だけなので今は実質 PRAGMA 専用だが、
  // 将来ダンプに `DROP` や `UPDATE` が現れると先頭へ飛ぶ。そのときは
  // ここで分類を足すこと。
  const leading = [];
  const indexes = [];
  // `sqlite_sequence` は AUTOINCREMENT を持つテーブルが作られて初めて
  // 暗黙に生成される。先頭へ送ると `no such table: sqlite_sequence` で落ちる。
  const sqliteInternal = [];

  for (const statement of statements) {
    if (statement.trim() === "") continue;
    const table = tableOf.exec(statement);
    if (table !== null) {
      creates.set(table[1], statement);
      parents.set(
        table[1],
        new Set([...statement.matchAll(parentOf)].map((m) => m[1]).filter((n) => n !== table[1])),
      );
      continue;
    }
    const target = rowsOf.exec(statement);
    if (target !== null) {
      if (target[1].startsWith("sqlite_")) sqliteInternal.push(statement);
      else rows.set(target[1], [...(rows.get(target[1]) ?? []), statement]);
      continue;
    }
    if (statement.startsWith("CREATE")) indexes.push(statement);
    else leading.push(statement);
  }

  // 外部キーの親から子へ。深さ優先で、訪問済みを後ろに積む。
  const order = [];
  const done = new Set();
  const visit = (name, stack) => {
    if (done.has(name) || !creates.has(name)) return;
    // 自己参照は上で除いてある。循環は D1 のスキーマに無いが、
    // 万一あっても無限再帰させない。
    if (stack.has(name)) return;
    for (const parent of [...parents.get(name)].sort()) visit(parent, new Set([...stack, name]));
    done.add(name);
    order.push(name);
  };
  for (const name of [...creates.keys()].sort()) visit(name, new Set());

  const out = [...leading];
  for (const name of order) out.push(creates.get(name));
  for (const name of order) out.push(...(rows.get(name) ?? []));
  // `CREATE TABLE` を持たないテーブルへの行（将来ダンプの形が変わった場合）。
  for (const [name, statements_] of rows) if (!creates.has(name)) out.push(...statements_);
  out.push(...sqliteInternal);
  out.push(...indexes);
  return `${out.join("\n")}\n`;
}
