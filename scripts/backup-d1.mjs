#!/usr/bin/env node
/**
 * D1 のバックアップを R2 へ退避する（#27 / docs/runbook.md 12）。
 *
 *   node scripts/backup-d1.mjs self-check
 *   node scripts/backup-d1.mjs export  [--db identity|nfc|all] [--local] [--out DIR]
 *   node scripts/backup-d1.mjs upload  --file F [--dry-run]
 *   node scripts/backup-d1.mjs run     [--db all] [--out DIR] [--dry-run]
 *   node scripts/backup-d1.mjs list    [--prefix P]
 *   node scripts/backup-d1.mjs restore --key K [--out DIR]
 *
 * 既定は `--remote`（本番 D1）。バックアップにローカル DB を取っても意味が
 * 無いので、他のスクリプトと既定が逆になっている。`--local` は手順の
 * 練習用（runbook 12.6 のリハーサル）。
 *
 * ## なぜ要るのか
 *
 * D1 の Time Travel は **30 日・同一 DB 内**にしか戻せない（runbook 12.2）。
 * 30 日より前へは戻せず、**DB ごと失うと復旧手段が無い**。取得した
 * エクスポートをアカウント外の保管先に置くまでが、この穴の塞ぎ方になる。
 *
 * ## 2 つの DB を必ず揃えて取る
 *
 * `u18-identity` と `u18-nfc` は別の D1 で、**片方だけ戻すと
 * `nfc_cards.owner_user_id` が存在しないユーザーを指す**（runbook 12.4 (5)）。
 * 既定が `--db all` なのはそのため。時刻を完全に揃えることはできないので、
 * ずれる前提で 2 つを近い時刻に取り、マニフェストへ両方の時刻を書く。
 *
 * ## エクスポートの中身は個人情報そのもの
 *
 * `users` / `user_emails` / `email_challenges` が平文のメールアドレスを持つ。
 * **バケットを公開しないこと。** 保持期間は runbook 12.6 で決める。
 * ローカルに落としたファイルは使い終わったら消す（`--out` の既定は
 * システムの一時ディレクトリで、リポジトリ内には置かない）。
 *
 * ## 2 つのアップロード経路
 *
 * | 経路        | 認証                        | いつ使うか                             |
 * | ----------- | --------------------------- | -------------------------------------- |
 * | `wrangler`  | wrangler のログイン or API トークン | 手元から。既定                  |
 * | `--s3`      | `.env` の S3 認証情報       | 無人実行（CI / cron）。トークン不要    |
 *
 * 既定を wrangler にしてあるのは、**秘密を増やさずに済むから**
 * （runbook 12.5）。CI は `CLOUDFLARE_API_TOKEN` を既に持っている。
 * `--s3` は wrangler を置けない実行環境向けに残してある。
 */

import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveSigningKey, signRequest, SIGNING_KEY_VECTORS } from "./lib/aws-sigv4.mjs";
import { reorderDump } from "./lib/d1-dump.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUCKET = "u18-identity-archive";
const PREFIX = "d1-backups";

/** 退避する D1。**両方取ること**（上記「2 つの DB を必ず揃えて取る」）。 */
const DATABASES = {
  identity: { name: "u18-identity", dir: join(ROOT, "apps/auth-worker") },
  nfc: { name: "u18-nfc", dir: join(ROOT, "apps/nfc-worker") },
};

function parseArgs(argv) {
  const flags = { db: "all", remote: true, dryRun: false, s3: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--local") flags.remote = false;
    else if (arg === "--remote") flags.remote = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--s3") flags.s3 = true;
    else if (arg === "--db") flags.db = argv[++i];
    else if (arg === "--out") flags.out = argv[++i];
    else if (arg === "--file") flags.file = argv[++i];
    else if (arg === "--key") flags.key = argv[++i];
    else if (arg === "--prefix") flags.prefix = argv[++i];
    else rest.push(arg);
  }
  return { flags, rest };
}

/** `.env` は gitignore 済み。読めなければ `--s3` を使わせない。 */
function readS3Credentials() {
  let text;
  try {
    text = readFileSync(join(ROOT, ".env"), "utf8");
  } catch {
    throw new Error("`.env` が読めない。S3_ENDPOINT / ACCESS_KEY / SECRET_KEY が要る");
  }
  const env = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match !== null) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  for (const key of ["S3_ENDPOINT", "ACCESS_KEY", "SECRET_KEY"]) {
    if (!env[key]) throw new Error(`.env に ${key} が無い`);
  }
  return env;
}

function wrangler(args, { cwd = ROOT, capture = false } = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd,
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`wrangler が失敗した (exit ${result.status})`);
  return result.stdout ?? "";
}

/** `d1-backups/2026/10/24/u18-identity-2026-10-24T12-34-56-789Z.sql` */
function backupKey(databaseName, at) {
  const iso = at.toISOString();
  const [date] = iso.split("T");
  return `${PREFIX}/${date.replaceAll("-", "/")}/${databaseName}-${iso.replace(/[:.]/g, "-")}.sql`;
}

// --- コマンド ---------------------------------------------------------------

/**
 * 署名の鍵導出を公開ベクタに当てる。
 *
 * **ここが落ちたら `--s3` を使わないこと。** 署名が狂ったアップロードは
 * 403 で弾かれるので黙って壊れはしないが、原因の切り分けを先に済ませる。
 */
function selfCheck() {
  let failed = 0;
  for (const vector of SIGNING_KEY_VECTORS) {
    const got = deriveSigningKey(
      vector.secretKey,
      vector.dateStamp,
      vector.region,
      vector.service,
    ).toString("hex");
    const ok = got === vector.expected;
    console.log(`${ok ? "OK  " : "FAIL"} ${vector.label}`);
    if (!ok) {
      console.log(`     expected ${vector.expected}`);
      console.log(`     got      ${got}`);
      failed++;
    }
  }
  if (failed > 0) throw new Error(`署名鍵の導出が公開ベクタと一致しない (${failed} 件)`);
  console.log("\nSigV4 の鍵導出は公開ベクタと一致している。");
  console.log(
    "※ 正規化リクエストの組み立ては 2026-10-25 に実サービスで確認済み（list が R2 から一覧を取得）。",
  );
}

function exportDatabases({ db, remote, out }) {
  const targets = db === "all" ? Object.keys(DATABASES) : [db];
  const at = new Date();
  const dir = out ?? join(tmpdir(), `u18-backup-${at.toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dir, { recursive: true });

  const files = [];
  for (const target of targets) {
    const database = DATABASES[target];
    if (database === undefined) throw new Error(`--db は ${Object.keys(DATABASES)} のどれか`);

    const file = join(dir, `${database.name}-${at.toISOString().replace(/[:.]/g, "-")}.sql`);
    console.log(`\n[${database.name}] エクスポート中 → ${file}`);
    wrangler(["d1", "export", database.name, remote ? "--remote" : "--local", "--output", file], {
      cwd: database.dir,
    });
    // 落とせたこと自体を確かめる。wrangler の exit 0 だけでは足りない。
    const { size } = statSync(file);
    if (size === 0) throw new Error(`${file} が空。エクスポートが成功していない`);
    console.log(`[${database.name}] ${size} バイト`);
    files.push({ database: database.name, file, bytes: size, exportedAt: at.toISOString() });
  }

  // 2 つの DB の取得時刻を 1 箇所に残す。復元時にどこまでずれているかの手掛かり。
  const manifest = join(dir, "manifest.json");
  writeFileSync(manifest, `${JSON.stringify({ takenAt: at.toISOString(), files }, null, 2)}\n`);
  console.log(`\nマニフェスト: ${manifest}`);
  return { dir, files, at };
}

async function uploadFile({ file, at, dryRun, s3 }) {
  const path = resolve(file);
  const body = readFileSync(path);
  const name = path
    .split("/")
    .pop()
    .replace(/-\d{4}-\d{2}-\d{2}T.*$/, "");
  const key = backupKey(name, at ?? new Date());

  if (dryRun) {
    console.log(`[dry-run] ${path} (${body.byteLength} バイト) → r2://${BUCKET}/${key}`);
    return key;
  }

  if (!s3) {
    console.log(`[wrangler] ${path} → r2://${BUCKET}/${key}`);
    wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", path, "--remote"]);
    return key;
  }

  const env = readS3Credentials();
  const url = new URL(`${env.S3_ENDPOINT.replace(/\/$/, "")}/${BUCKET}/${key}`);
  const headers = signRequest({
    method: "PUT",
    url,
    body,
    headers: { "content-type": "application/sql" },
    accessKey: env.ACCESS_KEY,
    secretKey: env.SECRET_KEY,
    now: new Date(),
  });

  console.log(`[s3] ${path} → ${url.pathname}`);
  const response = await fetch(url, { method: "PUT", headers, body });
  if (!response.ok) {
    throw new Error(`アップロードに失敗した: HTTP ${response.status} ${await response.text()}`);
  }
  return key;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const { flags } = parseArgs(argv);

  switch (command) {
    case "self-check":
      return selfCheck();

    case "export": {
      exportDatabases(flags);
      return;
    }

    case "upload": {
      if (!flags.file) throw new Error("--file が要る");
      const key = await uploadFile({ file: flags.file, dryRun: flags.dryRun, s3: flags.s3 });
      console.log(`\n完了: r2://${BUCKET}/${key}`);
      return;
    }

    case "run": {
      const { files, at } = exportDatabases(flags);
      for (const entry of files) {
        const key = await uploadFile({ file: entry.file, at, dryRun: flags.dryRun, s3: flags.s3 });
        console.log(`  ${entry.database} → r2://${BUCKET}/${key}`);
      }
      console.log("\n**ローカルに残ったファイルを消すこと。** 平文のメールアドレスが入っている。");
      return;
    }

    case "list": {
      // **wrangler には一覧が無い。** `wrangler r2 object` にあるのは
      // get / put / delete の 3 つだけで、`wrangler r2 bucket` 側にも
      // オブジェクトの一覧は無い（wrangler 4.152.0 で確認、#164）。
      // 以前はここが存在しないサブコマンドを呼んでいて、**一度も
      // 動いたことが無かった**。
      //
      // そのため list だけは S3 の ListObjectsV2 を使う。結果として
      // **list だけが `.env` の認証情報を要求する**——12.5 の
      // 「保管場所を増やさない」方針とは噛み合わないが、一覧を
      // 諦めるよりは良いと判断した。upload / restore は wrangler のまま。
      const env = readS3Credentials();
      const url = new URL(`${env.S3_ENDPOINT.replace(/\/$/, "")}/${BUCKET}`);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", flags.prefix ?? PREFIX);
      const headers = signRequest({
        method: "GET",
        url,
        accessKey: env.ACCESS_KEY,
        secretKey: env.SECRET_KEY,
        now: new Date(),
      });
      const response = await fetch(url, { method: "GET", headers });
      if (!response.ok) {
        throw new Error(`一覧に失敗した: HTTP ${response.status} ${await response.text()}`);
      }
      const xml = await response.text();
      const entries = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
        key: /<Key>(.*?)<\/Key>/.exec(m[1])?.[1] ?? "",
        size: /<Size>(.*?)<\/Size>/.exec(m[1])?.[1] ?? "",
        at: /<LastModified>(.*?)<\/LastModified>/.exec(m[1])?.[1] ?? "",
      }));
      if (entries.length === 0) {
        console.log(`r2://${BUCKET}/${flags.prefix ?? PREFIX} にオブジェクトが無い`);
        return;
      }
      for (const entry of entries) {
        console.log(`${entry.at}  ${String(entry.size).padStart(9)} バイト  ${entry.key}`);
      }
      return;
    }

    case "restore": {
      if (!flags.key) throw new Error("--key が要る");
      const dir = flags.out ?? tmpdir();
      mkdirSync(dir, { recursive: true });
      const file = join(dir, flags.key.split("/").pop());
      wrangler(["r2", "object", "get", `${BUCKET}/${flags.key}`, "--file", file, "--remote"]);
      console.log(`\n取得した: ${file}`);

      // 取得した生のダンプはそのまま残し、流す用を別ファイルに書く。
      // どちらが Cloudflare の出力かを後から見分けられるようにするため。
      const ready = file.replace(/\.sql$/, "") + ".restorable.sql";
      writeFileSync(ready, reorderDump(readFileSync(file, "utf8")));
      console.log(`並べ替えた: ${ready}`);

      // **既存の DB には流せない。** ダンプは `d1_migrations` の行まで
      // 含むので、中身のある DB に流すと最初の INSERT が
      // `UNIQUE constraint failed: d1_migrations.id` で止まる。
      // 「上書きで戻す」という操作は存在しない（runbook 12.8）。
      const name = (flags.key.split("/").pop() ?? "").startsWith("u18-nfc")
        ? "u18-nfc"
        : "u18-identity";
      console.log("\n復元先は**空の DB** でなければならない。既存の DB には流せない:");
      console.log(`  npx wrangler d1 create ${name}-restored`);
      console.log(`  npx wrangler d1 execute ${name}-restored --remote --file ${ready}`);
      console.log("\n中身を確認してから wrangler.jsonc の database_id を差し替える:");
      console.log(
        `  npx wrangler d1 execute ${name}-restored --remote --command "PRAGMA foreign_key_check"`,
      );
      console.log("\n**ローカルに残ったファイルを消すこと。** 平文のメールアドレスが入っている。");
      return;
    }

    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
      process.exitCode = command === undefined ? 0 : 1;
  }
}

main().catch((error) => {
  console.error(`\nエラー: ${error.message}`);
  process.exitCode = 1;
});
