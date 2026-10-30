/**
 * 取ったダンプが**実際に復元できる**ことを確かめる（#325）。
 *
 * ## なぜ「取れた」では足りないのか
 *
 * #164 / #165 がそれだった —— **ダンプは取れていた。復元できなかった。**
 * `wrangler d1 export` はテーブルをアルファベット順に並べるので、
 * `user_emails` の `INSERT` が `CREATE TABLE users` より先に来る。
 * 先頭の `PRAGMA defer_foreign_keys=TRUE` は効かない（`d1-dump.mjs` に詳述）。
 *
 * **厄介なのは、子テーブルに行が無い間は通ってしまうこと。** 問題の
 * `INSERT` 自体が生成されないので、**本番で最初のアカウントができた瞬間から
 * 壊れたことになり、「前は動いた」が成立する。**
 *
 * 自動化するとこの嘘が毎日出続ける。**「毎日成功している」は「戻せる」を
 * 意味しない。** だから取得と同じ run の中で、実際に流し込むところまでやる。
 *
 * ## ★空のデータベースでは、この検査は何も言わない
 *
 * **行数の一致も `foreign_key_check` の違反 0 も、空の DB では自動的に
 * 満たされる。** #165 の形をそのまま再現したものを緑と呼ぶことになる。
 *
 * そこで `requireRows` を取る。**流し込んだ後にそのテーブルへ行が無ければ
 * 落とす。** `users` と `user_emails` を渡すのは、#165 が「親より先に子の
 * INSERT が来る」で壊れていた以上、**その 2 つに行があることがリハーサルの
 * 前提条件**だからである。
 *
 * これは `check-webauthn-origin.mjs` の「0 件を調べて問題なし が一番まずい」
 * と同じ手当てである。**検査が何も見なかったことと、見て問題が無かったことを
 * 区別する。**
 *
 * ## なぜメモリ上の SQLite なのか
 *
 * 確かめたいのは **文の順序と外部キーの整合**で、どちらもローカルの SQLite で
 * 再現する。使い捨ての D1 をリモートに作る形だと `d1 create` / `d1 delete` の
 * 権限が要り、**本番アカウントに触れる面が増える。**
 *
 * そして `:memory:` にするのは、ダンプが**全利用者の平文メールアドレスを含む**
 * ため。ディスクへ書かなければ、消し忘れも残骸も無い。
 *
 * ## node:sqlite について
 *
 * Node 22 では `--experimental-sqlite` が要る（26 でも受け付けられる）。
 * import を関数の中へ遅延させてあるのは、**フラグ無しで読み込まれたときに
 * 「何をすればよいか」を言えるようにする**ため。モジュール先頭で落ちると
 * 呼び出し側には原因が分からない。
 */

/** リハーサル後に行が入っていなければ落とすテーブル。 */
export const REQUIRED_TABLES = ["users", "user_emails"];

async function openMemoryDatabase() {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    throw new Error(
      `node:sqlite を読み込めない（${error.message}）。` +
        `Node 22 では --experimental-sqlite を付けて実行すること`,
    );
  }
  return new sqlite.DatabaseSync(":memory:");
}

/**
 * ダンプを空のデータベースへ流し込み、結果を報告する。
 *
 * @param {string} sql 流し込む SQL（`reorderDump()` を通した後のもの）
 * @param {{ requireRows?: readonly string[] }} [options]
 * @returns {Promise<{ ok: boolean, problems: string[], tables: Record<string, number>, statementError: string | null }>}
 */
export async function rehearseRestore(sql, options = {}) {
  const requireRows = options.requireRows ?? REQUIRED_TABLES;
  const problems = [];
  /** @type {Record<string, number>} */
  const tables = {};
  let statementError = null;

  const db = await openMemoryDatabase();
  try {
    // **外部キーを強制する。ここを省くと #165 を再現できない。**
    //
    // SQLite は既定で外部キーを強制しない。一方、実際の復元は
    // `wrangler d1 execute --file` で、**D1 は強制する。** 強制しないまま
    // 流すと、親より先に子へ入れても通ってしまい、**検査が #165 の不具合を
    // 素通りさせる。**
    //
    // ダンプ先頭の `PRAGMA defer_foreign_keys=TRUE` には頼らない。あれは
    // トランザクションの中でしか効かず、しかも wrangler が文を分割して
    // 送るため後続に持続しない（それが #165 の原因そのものである）。
    // **ここでも同じく持続しない前提に揃える。**
    db.exec("PRAGMA foreign_keys = ON;");

    // **ここが #165 を捕まえる場所。** 親より先に子の INSERT が来ていれば
    // `no such table: main.users` で止まる。SQLite は最初の失敗で打ち切る。
    try {
      db.exec(sql);
    } catch (error) {
      statementError = error.message;
      problems.push(`ダンプを流し込めない: ${error.message}`);
      // 流し込めていない以上、この先の集計に意味は無い。
      return { ok: false, problems, tables, statementError };
    }

    // 外部キーの整合。**流し込みが通っただけでは、親の無い子が残りうる**
    // （SQLite は既定で外部キーを強制しないため）。
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      // **中身は出さない。** 違反行には利用者のデータが入る。
      // 出すのは「どのテーブルで何件か」まで。
      const byTable = {};
      for (const row of violations) {
        const name = String(row.table ?? row['"table"'] ?? "不明");
        byTable[name] = (byTable[name] ?? 0) + 1;
      }
      const summary = Object.entries(byTable)
        .map(([name, count]) => `${name}: ${count} 件`)
        .join(", ");
      problems.push(`外部キーの違反がある（${summary}）`);
    }

    // テーブルごとの行数。`sqlite_` で始まるものは SQLite の内部表。
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));

    for (const name of names) {
      // 表名は sqlite_master 由来なので外部入力ではないが、引用符で囲む。
      const row = db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get();
      tables[name] = Number(row?.n ?? 0);
    }

    if (names.length === 0) {
      problems.push("テーブルが 1 つも作られていない（ダンプが空の可能性）");
    }

    // ★空の DB で緑になる穴を塞ぐ。
    for (const name of requireRows) {
      if (!(name in tables)) {
        problems.push(`${name} が存在しない。ダンプがこの DB のものではない`);
        continue;
      }
      if (tables[name] === 0) {
        problems.push(
          `${name} に行が無い。**復元できたことの証明になっていない** ` +
            `—— 子テーブルが空なら #165 の不具合は再現せず、壊れたダンプでもここまで通る`,
        );
      }
    }
  } finally {
    db.close();
  }

  return { ok: problems.length === 0, problems, tables, statementError };
}
