#!/usr/bin/env node
/**
 * 管理権限の内部管理 CLI（#83 / 仕様書 §14.1 決定 8）。
 *
 * **そもそも「管理者」とは何か。**
 * 現時点の u18 Identity に、管理者だけが叩けるアプリ上の機能は 1 つも無い。
 * 運用はすべて `wrangler` による DB 直接操作で、その権限は Cloudflare
 * アカウントが持つ（docs/runbook.md §10.5「アプリ上の管理者は存在せず、
 * インフラ管理者しかいない」）。**つまり `users.is_admin` を立てても、
 * 今それで到達できる管理操作は無い。**
 *
 * それでもこの旗と CLI に意味があるのは、守る順序が逆だからである。
 * ロールの概念が無いままでも「管理者」と名付けたアカウントは作れてしまい、
 * そのアカウントはメール OTP で入れる普通のアカウントである。つまり
 * **管理機能より先に、管理者という呼び名のほうが生まれる。** #83 が塞ぐのは
 * そこで、管理操作が実装される前に「管理者は Passkey でしか入れない」を
 * 強制側に用意しておく。後から足す管理操作は、入口ごとに認可を書くのではなく
 * 「OTP セッションの管理者は存在しない」という前提の上に乗ればよい。
 *
 * **ここに書いていないことは、まだ決まっていない。** 役割の種類、権限の細分化、
 * 管理 UI —— どれも仕様書 §1.2（組織・チーム権限管理は非目標）の外にあり、
 * 「将来こう使うだろう」で先に作らない。
 *
 * 使い方:
 *
 *   node scripts/admin-role.mjs status --user-id usr_xxx [--remote]
 *   node scripts/admin-role.mjs grant  --user-id usr_xxx --actor <実行者> [--remote]
 *   node scripts/admin-role.mjs revoke --user-id usr_xxx --actor <実行者> [--remote]
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
 * ここで SQL を書き直すと、**テストが検証している文と運用が流す文が別物になる。**
 * `test/admin-role.test.ts` は `admin-role.sql.ts` が返す文を実物の D1 に流して
 * 「Passkey が無ければ権限が立たない」ことを確かめており、CLI がその文を
 * 使わなくなった瞬間にその保証は切れる。Node の型ストリップ（22.18 以降）で
 * TypeScript をそのまま import する。
 */
async function loadSql() {
  try {
    return await import(join(WORKER_DIR, "src/infrastructure/persistence/admin-role.sql.ts"));
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

function requireUserId(options) {
  if (!options.userId) throw new Error("--user-id は必須");
}

/**
 * 実行者の記録を必須にする。
 *
 * 権限の増減は、後から「誰がやったか」を辿れないと意味が無い（runbook §10.6）。
 * **メールアドレスや本名は入れないこと** —— 監査ログに個人情報を残さない
 * （`src/application/ports/audit-log.port.ts`）。GitHub のハンドルで足りる。
 */
function requireActor(options) {
  if (!options.actor) throw new Error("--actor は必須（誰が実行したかを監査ログに残す）");
}

function printStatus(rows) {
  if (rows.length === 0) {
    console.log("該当するユーザーが居ない。--user-id を確認すること");
    return null;
  }
  const row = rows[0];
  console.log(`  id:            ${row.id}`);
  console.log(`  username:      ${row.username}`);
  console.log(`  status:        ${row.status}${row.is_deleted ? "（論理削除済み）" : ""}`);
  console.log(`  is_admin:      ${row.is_admin ? "はい" : "いいえ"}`);
  console.log(`  passkeys:      ${row.passkeys} 本`);
  console.log(`  OTP セッション: ${row.otp_sessions} 件（生きているもの）`);
  return row;
}

async function status(options) {
  requireUserId(options);
  const sql = await loadSql();
  const statement = sql.adminRoleStatusSql(options.userId);
  if (options.dryRun) {
    console.log(statement);
    return;
  }
  printStatus(queryRows(statement, options));
}

async function grant(options) {
  requireUserId(options);
  requireActor(options);
  const sql = await loadSql();

  const grantStatement = sql.grantAdminSql(options.userId);
  const revokeSessionsStatement = sql.revokeNonPasskeySessionsSql(options.userId);
  const auditStatement = sql.adminRoleAuditSql({
    event: "ops.admin.granted",
    userId: options.userId,
    actor: options.actor,
    reason: options.reason ?? "manual_grant",
  });

  if (options.dryRun) {
    console.log([grantStatement, revokeSessionsStatement, auditStatement].join("\n\n"));
    return;
  }

  console.log("付与前の状態:");
  const before = printStatus(queryRows(sql.adminRoleStatusSql(options.userId), options));
  if (before === null) {
    process.exitCode = 1;
    return;
  }

  // 付与できたかどうかは UPDATE の返り行で判断する。事前の SELECT で判断すると、
  // その間に最後の Passkey が消えても気付けない（admin-role.sql.ts の TOCTOU の話）。
  const granted = queryRows(grantStatement, options);
  if (granted.length === 0) {
    console.log("");
    console.log("付与しなかった。条件を満たしていない:");
    console.log("  - Passkey が 1 本以上あること（決定 8 により管理者は Passkey でしか入れない）");
    console.log("  - status が active で、論理削除されていないこと");
    console.log("  - まだ管理者でないこと");
    process.exitCode = 1;
    return;
  }

  // 付与より前に張られた OTP セッションは、この瞬間「OTP で入った管理者の
  // セッション」になる。落とすまでが付与の手順である。
  const revoked = queryRows(revokeSessionsStatement, options);
  runSql(auditStatement, options);

  console.log("");
  console.log(`管理権限を付与した: ${options.userId}`);
  console.log(`  失効させた OTP セッション: ${revoked.length} 件`);
  console.log("  以後このアカウントは Passkey でしかログインできない（仕様書 §14.1 決定 8）");
  console.log("  最後の Passkey は削除できない（DeletePasskeyUseCase が拒否する）");
}

async function revoke(options) {
  requireUserId(options);
  requireActor(options);
  const sql = await loadSql();

  const revokeStatement = sql.revokeAdminSql(options.userId);
  const auditStatement = sql.adminRoleAuditSql({
    event: "ops.admin.revoked",
    userId: options.userId,
    actor: options.actor,
    reason: options.reason ?? "manual_revoke",
  });

  if (options.dryRun) {
    console.log([revokeStatement, auditStatement].join("\n\n"));
    return;
  }

  const revoked = queryRows(revokeStatement, options);
  if (revoked.length === 0) {
    console.log("剥奪しなかった。そのユーザーは管理者ではない（または存在しない）");
    process.exitCode = 1;
    return;
  }
  runSql(auditStatement, options);

  console.log(`管理権限を剥奪した: ${options.userId}`);
  // セッションは落とさない。剥奪後に残るのは Passkey で張った普通のセッションで、
  // 一般利用者として持っていてよいものである（権限の判定は毎回 users を引く）。
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);

  switch (command) {
    case "status":
      await status(options);
      break;
    case "grant":
      await grant(options);
      break;
    case "revoke":
      await revoke(options);
      break;
    default:
      console.error("使い方: node scripts/admin-role.mjs <status|grant|revoke> --user-id <id> ...");
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`エラー: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
