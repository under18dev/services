#!/usr/bin/env node
/**
 * 承認リストの内部管理 CLI（運用者の判断、2026-10-30 夜）。
 *
 * **u18 Identity 側には何も足さない。** `admin.under18.dev` には誰でも
 * OIDC でログインできる。「誰が管理画面を使ってよいか」は admin-worker
 * 専用の D1（`ADMIN_DB`）に持つ記憶で決まる——その D1 を直接触る、
 * 唯一の経路がこの CLI である（画面からの承認はまだ無い。承認する側の
 * 画面「誰が待っているか」が無いため）。
 *
 * **最初の 1 人はこれでしか入れられない。** `grant` は UPSERT なので、
 * 既存の承認を昇格・降格させるのにも使える。
 *
 * 使い方:
 *
 *   node scripts/admin-approval.mjs status --sub usr_xxx [--remote]
 *   node scripts/admin-approval.mjs list [--remote]
 *   node scripts/admin-approval.mjs grant  --sub usr_xxx --actor <実行者> [--super] [--remote]
 *   node scripts/admin-approval.mjs revoke --sub usr_xxx --actor <実行者> [--remote]
 *
 * 既定は `--local`（miniflare のローカル D1）。本番へ当てるときだけ `--remote`。
 * `--dry-run` は SQL を表示するだけで実行しない。
 *
 * ## `--remote` を使うとき: 口座が複数あるなら指定が要る
 *
 * **Cloudflare の口座を 2 つ以上持っている環境では、口座を指定しない
 * wrangler は失敗する**（`apps/auth-worker/scripts/admin-role.mjs` と
 * 同じ注意。2026-10-30、複数口座の実機で確認済み）。
 *
 *   npx wrangler whoami
 *   CLOUDFLARE_ACCOUNT_ID=<口座 ID> node scripts/admin-approval.mjs grant ...
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeWranglerFailure } from "./lib/wrangler-failure.ts";

const WORKER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATABASE_NAME = "u18-admin";

/**
 * SQL は Worker 側の実装をそのまま読み込む。
 *
 * ここで SQL を書き直すと、**テストが検証している文と運用が流す文が
 * 別物になる**（`admin-role.mjs` と同じ理由）。Node の型ストリップ
 * （22.18 以降）で TypeScript をそのまま import する。
 */
async function loadSql() {
  try {
    return await import(join(WORKER_DIR, "src/infrastructure/persistence/approval.sql.ts"));
  } catch (error) {
    throw new Error(
      `TypeScript を直接読み込めなかった。Node 22.18 以降（型ストリップ対応）が要る: ${error}`,
    );
  }
}

/**
 * wrangler を呼ぶ。
 *
 * **`--json` を付けた wrangler は、エラーを stdout に JSON で書く。
 * stderr は空である**（#379 の実測。`lib/wrangler-failure.ts` を参照）。
 * 失敗時に stdout を捨てると原因がどこにも残らないので、捕まえた出力を
 * そのまま `describeWranglerFailure` へ渡す。
 */
function wrangler(args, { json = false, remote = false } = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: WORKER_DIR,
    stdio: json ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      describeWranglerFailure({ status: result.status, stdout: result.stdout, remote }),
    );
  }
  return result.stdout ?? "";
}

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
    { json: true, remote: options.remote },
  );
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error(`wrangler の出力を JSON として読めなかった:\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(start));
  return Array.isArray(parsed) ? (parsed[0]?.results ?? []) : (parsed.results ?? []);
}

function runSql(sql, options) {
  wrangler(
    ["d1", "execute", DATABASE_NAME, options.remote ? "--remote" : "--local", "--command", sql],
    { remote: options.remote },
  );
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
      case "--sub":
        options.sub = next();
        break;
      case "--actor":
        options.actor = next();
        break;
      case "--reason":
        options.reason = next();
        break;
      case "--super":
        options.superApprover = true;
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

function requireSub(options) {
  if (!options.sub) throw new Error("--sub は必須");
}

/**
 * 実行者の記録を必須にする。
 *
 * 承認の増減は、後から「誰がやったか」を辿れないと意味が無い
 * （`admin-role.mjs` の `requireActor` と同じ理由）。
 * **メールアドレスや本名は入れないこと。** GitHub のハンドルで足りる。
 */
function requireActor(options) {
  if (!options.actor) throw new Error("--actor は必須（誰が実行したかを監査ログに残す）");
}

function printRow(row) {
  if (row === undefined) {
    console.log("承認されていない。--sub を確認すること");
    return;
  }
  console.log(`  id:                ${row.id}`);
  console.log(`  sub:               ${row.sub}`);
  console.log(`  is_super_approver: ${row.is_super_approver ? "はい" : "いいえ"}`);
  console.log(`  approved_by_sub:   ${row.approved_by_sub ?? "（CLI でのブートストラップ）"}`);
  console.log(`  created_at:        ${new Date(row.created_at).toISOString()}`);
}

async function status(options) {
  requireSub(options);
  const sql = await loadSql();
  const statement = sql.approvalStatusSql(options.sub);
  if (options.dryRun) {
    console.log(statement);
    return;
  }
  printRow(queryRows(statement, options)[0]);
}

async function list(options) {
  const sql = await loadSql();
  const statement = sql.listApprovalsSql();
  if (options.dryRun) {
    console.log(statement);
    return;
  }
  const rows = queryRows(statement, options);
  if (rows.length === 0) {
    console.log("承認されている人が 1 人も居ない。");
    return;
  }
  for (const row of rows) {
    printRow(row);
    console.log("");
  }
  console.log(`合計 ${rows.length} 人`);
}

async function grant(options) {
  requireSub(options);
  requireActor(options);
  const sql = await loadSql();

  const grantStatement = sql.grantApprovalSql(options.sub, options.superApprover === true);
  const auditStatement = sql.approvalAuditSql({
    event: sql.APPROVAL_AUDIT_EVENTS.granted.event,
    sub: options.sub,
    actor: options.actor,
    reason: options.reason ?? "manual_grant",
  });

  if (options.dryRun) {
    console.log([grantStatement, auditStatement].join("\n\n"));
    return;
  }

  const granted = queryRows(grantStatement, options);
  if (granted.length === 0) {
    console.log("承認しなかった（想定外。grant は常に適用されるはず）。");
    process.exitCode = 1;
    return;
  }
  runSql(auditStatement, options);

  console.log(`承認した: ${options.sub}`);
  console.log(`  is_super_approver: ${granted[0].is_super_approver ? "はい" : "いいえ"}`);
}

async function revoke(options) {
  requireSub(options);
  requireActor(options);
  const sql = await loadSql();

  const revokeStatement = sql.revokeApprovalSql(options.sub);
  const auditStatement = sql.approvalAuditSql({
    event: sql.APPROVAL_AUDIT_EVENTS.revoked.event,
    sub: options.sub,
    actor: options.actor,
    reason: options.reason ?? "manual_revoke",
  });

  if (options.dryRun) {
    console.log([revokeStatement, auditStatement].join("\n\n"));
    return;
  }

  const revoked = queryRows(revokeStatement, options);
  if (revoked.length === 0) {
    console.log("剥奪しなかった。その sub は承認されていない");
    process.exitCode = 1;
    return;
  }
  runSql(auditStatement, options);

  console.log(`承認を剥奪した: ${options.sub}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);

  switch (command) {
    case "status":
      await status(options);
      break;
    case "list":
      await list(options);
      break;
    case "grant":
      await grant(options);
      break;
    case "revoke":
      await revoke(options);
      break;
    default:
      console.error(
        "使い方: node scripts/admin-approval.mjs <status|list|grant|revoke> --sub <sub> ...",
      );
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`エラー: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
