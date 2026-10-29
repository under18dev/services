#!/usr/bin/env node
/**
 * 凍結アカウントから個人情報を落とす運用 CLI（#265 / ランブック §11.6）。
 *
 * ## これは元に戻せない
 *
 * `username` / `display_name` / `primary_email` と `user_emails` の行は
 * **復元できない。** バックアップから戻す以外に手段が無い（§12.8）。
 * だから既定は `--dry-run` 相当で、実行には `--confirm <user_id>` が要る。
 *
 * ## 自動では走らない
 *
 * 2026-10-28 の方針 ——「管理者が任意で削除できるようにしながらも、一応その
 * 操作があるまでは残す」。cron もジョブも作らない。**運用者が手で叩く。**
 *
 * 「最終利用から 1 年」という基準も同日に決まったが、**それは対象を洗い出す
 * 基準であって、期限が来たら勝手に消す仕組みではない。** 洗い出しのほうは
 * まだ実装していない（判定に使える列が無い。#265 を参照）。
 *
 * 使い方:
 *
 *   node scripts/purge-user.mjs status  --user-id usr_xxx [--remote]
 *   node scripts/purge-user.mjs purge   --user-id usr_xxx --actor <実行者> \
 *     --reason <理由> --confirm usr_xxx [--remote]
 *
 * 既定は `--local`（miniflare のローカル D1）。本番へ当てるときだけ `--remote`。
 * `--dry-run` は SQL を表示するだけで実行しない。
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATABASE_NAME = "u18-identity";

/**
 * SQL は Worker 側の実装をそのまま読み込む。
 *
 * ここで SQL を書き直すと、**テストが検証している文と運用が流す文が別物に
 * なる。** `test/purge-user.test.ts` は `purge-user.sql.ts` が返す文を実物の
 * D1 に流して確かめており、CLI がその文を使わなくなった瞬間に保証が切れる
 * （`admin-role.mjs` と同じ理由）。
 */
async function loadSql() {
  try {
    return await import(join(WORKER_DIR, "src/infrastructure/persistence/purge-user.sql.ts"));
  } catch (error) {
    throw new Error(
      `TypeScript を直接読み込めなかった。Node 22.18 以降（型ストリップ対応）が要る: ${error}`,
    );
  }
}

function wrangler(args, { json = false } = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: WORKER_DIR,
    stdio: json ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`wrangler が失敗した (exit ${result.status})`);
  return result.stdout ?? "";
}

/** 結果の行を読む。シェルを通さないので、SQL に含まれる記号は解釈されない。 */
function queryRows(sql, options) {
  const stdout = wrangler(
    [
      "d1",
      "execute",
      DATABASE_NAME,
      options.remote ? "--remote" : "--local",
      "--json",
      "--command",
      sql,
    ],
    { json: true },
  );
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error(`wrangler の出力を JSON として読めなかった:\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(start));
  return Array.isArray(parsed) ? (parsed[0]?.results ?? []) : (parsed.results ?? []);
}

function runSql(sql, options) {
  wrangler([
    "d1",
    "execute",
    DATABASE_NAME,
    options.remote ? "--remote" : "--local",
    "--command",
    sql,
  ]);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} に値が無い`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--user-id":
        options.userId = next();
        break;
      case "--actor":
        options.actor = next();
        break;
      case "--reason":
        options.reason = next();
        break;
      case "--confirm":
        options.confirm = next();
        break;
      case "--remote":
        options.remote = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`未知のオプション: ${arg}`);
    }
  }
  return options;
}

function printStatus(rows) {
  if (rows.length === 0) {
    console.log("  該当するユーザーが見つからない");
    return null;
  }
  const row = rows[0];
  for (const [key, value] of Object.entries(row)) console.log(`  ${key}: ${value}`);
  return row;
}

async function status(options) {
  if (!options.userId) throw new Error("--user-id は必須");
  const sql = await loadSql();
  const statement = sql.purgeStatusSql(options.userId);
  if (options.dryRun) {
    console.log(statement);
    return;
  }
  printStatus(queryRows(statement, options));
}

async function purge(options) {
  if (!options.userId) throw new Error("--user-id は必須");
  if (!options.actor) {
    throw new Error("--actor は必須（誰が実行したかを監査ログに残す。本名やメールは入れない）");
  }
  if (!options.reason) {
    throw new Error("--reason は必須（なぜ落としたか。チケット番号で足りる）");
  }

  const sql = await loadSql();
  const statements = [
    sql.purgeUserSql(options.userId),
    sql.deleteUserEmailsSql(options.userId),
    ...sql.revokeEverythingSql(options.userId),
    sql.purgeUserAuditSql({
      userId: options.userId,
      actor: options.actor,
      reason: options.reason,
    }),
  ];

  if (options.dryRun) {
    console.log(statements.join("\n\n"));
    return;
  }

  // **`--confirm` に ID をもう一度打たせる。** この操作は元に戻せないので、
  // 「打ち間違えた ID で実行した」を手数で止める。`y/n` の確認にしないのは、
  // **どの ID を消すのかを目で突き合わせる**ところまでやらせたいため。
  if (options.confirm !== options.userId) {
    console.error("::error::--confirm に --user-id と同じ値を渡すこと。この操作は元に戻せない。");
    console.error(
      `  node scripts/purge-user.mjs purge --user-id ${options.userId} ... --confirm ${options.userId}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log("落とす前の状態:");
  const before = printStatus(queryRows(sql.purgeStatusSql(options.userId), options));
  if (before === null) {
    process.exitCode = 1;
    return;
  }

  // 落とせたかどうかは UPDATE の返り行で判断する。事前の SELECT で判断すると、
  // その間に状態が変わっても気付けない（admin-role.sql.ts と同じ TOCTOU の話）。
  const purged = queryRows(statements[0], options);
  if (purged.length === 0) {
    console.log("");
    console.log("落とさなかった。既に status = 'deleted' か、ユーザーが存在しない。");
    process.exitCode = 1;
    return;
  }

  // **ここから先は、途中で失敗しても戻せない。** 1 つ目の UPDATE が通った
  // 時点で個人情報は消えているので、残りは必ず流し切る。
  for (const statement of statements.slice(1)) runSql(statement, options);

  console.log("");
  console.log("落としたあとの状態:");
  printStatus(queryRows(sql.purgeStatusSql(options.userId), options));
  console.log("");
  console.log("監査ログに user.purged を残した。**この操作は元に戻せない。**");
}

const [command, ...rest] = process.argv.slice(2);
const options = parseArgs(rest);

try {
  switch (command) {
    case "status":
      await status(options);
      break;
    case "purge":
      await purge(options);
      break;
    default:
      console.error("usage: purge-user.mjs <status|purge> --user-id usr_xxx [...]");
      process.exitCode = 2;
  }
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
