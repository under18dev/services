#!/usr/bin/env node
/**
 * D1 のバックアップを R2 へ退避する（#27 / docs/runbook.md 12）。
 *
 *   node scripts/backup-d1.mjs self-check
 *   node scripts/backup-d1.mjs export  [--db identity|nfc|all] [--local] [--out DIR]
 *   node scripts/backup-d1.mjs upload  --file F [--dry-run]
 *   node scripts/backup-d1.mjs run     [--db all] [--out DIR] [--dry-run]
 *                                      [--encrypt-to age1... | --allow-plaintext]
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
 * ## 3 つの DB を必ず揃えて取る
 *
 * `u18-identity` と `u18-nfc` は別の D1 で、**片方だけ戻すと
 * `nfc_cards.owner_user_id` が存在しないユーザーを指す**（runbook 12.4 (5)）。
 * 既定が `--db all` なのはそのため。時刻を完全に揃えることはできないので、
 * ずれる前提で近い時刻に取り、マニフェストへ全部の時刻を書く。
 *
 * **3 つ目は `u18-admin`**（承認リスト、#390）。こちらは外部キーで
 * 繋がってはいない —— **Identity 側には何も載っていない**ので、整合性の
 * 問題ではなく**単独で失うと誰も管理画面に入れなくなる**という話である。
 * **DB が増えたらここへ足すこと。** 足し忘れても他の 2 つは取れるので、
 * **バックアップは成功し続ける。**
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
import { readFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveSigningKey, signRequest, SIGNING_KEY_VECTORS } from "./lib/aws-sigv4.mjs";
import { ageBinary, assertAgeBytes, assertRecipient } from "./lib/age.mjs";
import { reorderDump } from "./lib/d1-dump.mjs";
import { countInsertsByTable, rehearseRestore } from "./lib/restore-rehearsal.mjs";
import { assertHttpsEndpoint } from "./lib/s3-endpoint.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUCKET = "u18-identity-archive";
const PREFIX = "d1-backups";

/**
 * 退避する D1。**全部取ること**（上記「2 つの DB を必ず揃えて取る」）。
 *
 * **`export` してある。** `scripts/check-backup-freshness.mjs`（#361）が
 * 「どの DB を見張るべきか」をここから読む —— 名前を 2 箇所に書くと、
 * DB が増えたときに片方だけ直される（このリポジトリが何度も踏んでいる
 * 形）。**ここを直せば、見張りが見る対象も自動で増える。**
 */
export const DATABASES = {
  identity: {
    name: "u18-identity",
    dir: join(ROOT, "apps/auth-worker"),
    // **リハーサルで行があることを要求するテーブル**（#325）。
    // 空の DB では復元検査が自動的に通ってしまうので、#165 が壊れていた
    // 「親より先に子の INSERT」が実際に起こりうる状態であることを要求する。
    requireRows: ["users", "user_emails"],
  },
  nfc: {
    name: "u18-nfc",
    dir: join(ROOT, "apps/nfc-worker"),
    // **こちらは「行があること」を要求しない。** カードは本番でも正当に
    // 0 件でありうるので、行を要求すると偽陽性になる。
    //
    // **それでも「空だから通った」にはならない。** ダンプの `INSERT` 件数と
    // 流し込み後の行数を突き合わせているので（`countInsertsByTable()`）、
    // 0 件なら 0 件同士で一致し、**文が流れなければ件数のずれとして出る。**
    // 閾値を置かずに済むのはそのため。
    requireRows: [],
  },
  admin: {
    name: "u18-admin",
    dir: join(ROOT, "apps/admin-worker"),
    // **承認リスト**（`admin_approvals` / `admin_approval_events`、#390）。
    //
    // **行があることを要求しない。** ブートストラップ前は**正当に 0 件**
    // である —— 最初の 1 人は CLI で入れる（#390 の「鶏と卵」）。
    // 行を要求すると、**その 1 人を入れるまでバックアップが落ち続ける。**
    //
    // nfc と同じく、**「空だから通った」にはならない** —— ダンプの
    // `INSERT` 件数と流し込み後の行数を突き合わせている。
    //
    // **取らないと承認リストだけ失われる。** この D1 が消えると、
    // **誰も管理画面に入れなくなる**（Identity 側には何も載っていない）。
    // 復旧は CLI での再ブートストラップになるが、**誰が承認されていたかは
    // 戻らない。**
    requireRows: [],
  },
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
    else if (arg === "--encrypt-to") flags.encryptTo = argv[++i];
    else if (arg === "--allow-plaintext") flags.allowPlaintext = true;
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

  assertHttpsEndpoint(env.S3_ENDPOINT);

  return env;
}

/**
 * 退避先のディレクトリ。`--out` が無いときの既定。
 *
 * **`tmpdir()` を直接使わない。** システムの一時ディレクトリは
 * world-readable（mode 1777）で、名前も時刻から予測できる。ここへ落ちるのは
 * **全利用者の平文メールアドレスを含む D1 の完全な複製**なので、同じ機械の
 * 他の利用者から読める状態になる（CodeQL `js/insecure-temporary-file`）。
 *
 * `mkdtempSync` は mode 0700 のディレクトリを一意な名前で作る。名前を
 * 推測されても中へ入れない。
 *
 * **`--out` を自分で指定する場合は、権限の責任は呼び出し側にある。**
 * CI のランナーのように使い捨ての環境ならそれでよい。
 */
function defaultOutDir(prefix) {
  const base = join(tmpdir(), prefix);
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(base);
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

/**
 * `d1-backups/2026/10/24/u18-identity-2026-10-24T12-34-56-789Z.sql.age`
 *
 * **拡張子を引数に取るのは、暗号化したものを `.sql` として置かないため。**
 * キーだけを見て平文だと思った人が、開けると思って取りに来る。
 */
function backupKey(databaseName, at, ext = ".sql") {
  const iso = at.toISOString();
  const [date] = iso.split("T");
  return `${PREFIX}/${date.replaceAll("-", "/")}/${databaseName}-${iso.replace(/[:.]/g, "-")}${ext}`;
}

/**
 * 取ったダンプを**実際に流し込んで**復元できることを確かめる（#325）。
 *
 * **「取れた」と「戻せる」は別である。** #164 / #165 がまさにそれで、
 * ダンプは毎回取れていたのに復元できなかった。自動化するとその嘘が
 * 毎日出続けるので、**取得と同じ実行の中で、封をする前に確かめる。**
 *
 * ## なぜ暗号化する前なのか
 *
 * 暗号化は age の**公開鍵**で行い、秘密鍵は運用者の手元にしか無い
 * （runbook 12.11）。つまり **CI は自分が作ったバックアップを開けない。**
 * 保管物に対してリハーサルすることは原理的にできないので、
 * **封をする前の、まさにそのバイト列**に対して行う。保管物と中身が
 * 同一なので「取れたものは戻せる」が毎回言える。
 *
 * **これが証明しないもの**: 暗号化そのものの壊れ方（受信者の取り違え、
 * age の呼び出しの失敗）と、**運用者の秘密鍵で実際に復号できること。**
 * 前者は `verifyUploaded()` が部分的に見る。後者は CI では言えないので、
 * runbook 12.11 の期限として `pnpm check:deadlines` に見させている。
 */
async function rehearseFile({ database, file, requireRows }) {
  // 保管するのは Cloudflare が吐いた生のダンプだが、**復元時は並べ替える**
  // （`d1-dump.mjs`）。リハーサルも復元と同じ形に揃える。
  const raw = readFileSync(file, "utf8");

  // **数えるのは並べ替える前。** 流し込み後の行数と突き合わせることで、
  // 「文が流れなかった」と「並べ替えで文が落ちた」の両方が件数のずれとして出る。
  const expectedRows = countInsertsByTable(raw);

  const ready = reorderDump(raw);
  const result = await rehearseRestore(ready, { requireRows, expectedRows });

  const counted = Object.entries(result.tables)
    .map(([name, rows]) => `${name}=${rows}`)
    .join(" ");
  console.log(
    `[${database}] リハーサル: ${Object.keys(result.tables).length} テーブル / ${counted}`,
  );

  if (!result.ok) {
    // **問題は全部出す。** 1 つ目で打ち切ると、残りを知るために
    // もう 1 周回すことになる。
    for (const problem of result.problems) console.error(`  - ${problem}`);
    throw new Error(`[${database}] 復元リハーサルに失敗した。このダンプは戻せない`);
  }
  return result;
}

/**
 * age の公開鍵で暗号化する（#325 / runbook 12.11）。
 *
 * **CI に置くのは公開鍵だけ。** 共通鍵を CI に置くと鍵も Cloudflare 側の
 * 管理下に入り、「アカウントごと失う」というバックアップの前提そのものが
 * 崩れる。復号できるのは運用者の手元の秘密鍵だけにする。
 *
 * 鍵そのものはここで作らない。**作った側がそれを見たことになる。**
 * 生成手順は runbook 12.11 にあり、実行するのは運用者である。
 */
function encryptFile(path, recipient) {
  // **受信者を使う前に形を確かめる。** 秘密鍵を渡していたらここで止まる。
  const to = assertRecipient(recipient);
  const out = `${path}.age`;
  const bin = ageBinary();

  const result = spawnSync(bin, ["--recipient", to, "--output", out, path], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.error !== undefined && result.error.code === "ENOENT") {
    throw new Error(`\`${bin}\` が見つからない。age を入れるか AGE_BIN で場所を渡すこと`);
  }
  if (result.status !== 0) throw new Error(`age が失敗した (exit ${result.status})`);

  // こちらも 1 回だけ読む（上と同じ理由）。
  const produced = readFileSync(out);
  assertAgeBytes(produced, out);
  console.log(`[age] ${path} → ${out} (${produced.byteLength} バイト)`);
  return out;
}

/**
 * 上げたものを取り直して確かめる（#325）。
 *
 * **復号はできない**（秘密鍵が無い）ので、見るのは 2 つだけ:
 * age のヘッダで始まること、バイト長が一致すること。
 * **0 バイトを put した形と、暗号化されずに上がった形が捕まる。**
 * それ以上は、鍵を持っている人にしか確かめられない。
 */
function verifyUploaded({ key, localPath, expectEncrypted }) {
  const dir = defaultOutDir("u18-verify-");
  const path = join(dir, "readback.bin");
  wrangler(["r2", "object", "get", `${BUCKET}/${key}`, "--file", path, "--remote"]);

  // **取り直したファイルは 1 回しか読まない**（CodeQL `js/file-system-race`）。
  //
  // 以前はここで `statSync()` してから `readFileSync()` していた。
  // **長さを測ったファイルと、中身を見たファイルが同じである保証が無い。**
  // このスクリプトが扱うのは全利用者の平文メールアドレスを含むダンプで、
  // 「検査した対象と操作した対象が違う」は**暗号化したつもりのものが別物**
  // という形に化ける。長さも中身も同じバッファから取る。
  //
  // `localPath` は逆に 1 回しか触らない（長さだけが要る）ので stat のまま。
  const expected = statSync(localPath).size;
  const readBack = readFileSync(path);
  if (readBack.byteLength !== expected) {
    throw new Error(`読み戻しのバイト長が違う: 期待 ${expected} / 実際 ${readBack.byteLength}`);
  }
  if (expectEncrypted) assertAgeBytes(readBack, `r2://${BUCKET}/${key}`);
  console.log(
    `[verify] r2://${BUCKET}/${key} (${readBack.byteLength} バイト) を読み戻して確認した`,
  );
  rmSync(dir, { recursive: true, force: true });
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
  const dir = out ?? defaultOutDir("u18-backup-");
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
    files.push({
      database: database.name,
      file,
      bytes: size,
      exportedAt: at.toISOString(),
      requireRows: database.requireRows,
    });
  }

  // 2 つの DB の取得時刻を 1 箇所に残す。復元時にどこまでずれているかの手掛かり。
  const manifest = join(dir, "manifest.json");
  writeFileSync(manifest, `${JSON.stringify({ takenAt: at.toISOString(), files }, null, 2)}\n`);
  console.log(`\nマニフェスト: ${manifest}`);
  return { dir, files, at };
}

async function uploadFile({ file, at, dryRun, s3, ext = ".sql" }) {
  const path = resolve(file);
  const body = readFileSync(path);
  const name = path
    .split("/")
    .pop()
    .replace(/-\d{4}-\d{2}-\d{2}T.*$/, "");
  const key = backupKey(name, at ?? new Date(), ext);

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
      // **鍵が無ければ上げない。** ダンプは全利用者の平文メールアドレスを
      // 含む。R2 の保存時暗号化だけだと、**R2 のアクセス権を取った相手には
      // 平文**である（#325 の決定 3）。
      //
      // 既定を「暗号化する」にして、平文で上げるには `--allow-plaintext` を
      // 明示させる。**忘れたときに安全でないほうへ倒れない**ようにするため。
      const recipient = flags.encryptTo ?? process.env.AGE_RECIPIENT;
      if (!recipient && !flags.allowPlaintext) {
        throw new Error(
          "暗号化の宛先が無い。`--encrypt-to age1...` か環境変数 AGE_RECIPIENT を渡すこと。" +
            "平文で上げる場合は --allow-plaintext を明示する（runbook 12.11）",
        );
      }

      const { files, at } = exportDatabases(flags);

      for (const entry of files) {
        // **封をする前に、戻せることを確かめる。** ここを通らなかったものは
        // 上げない —— 戻せないバックアップを「取れた」と記録しないため。
        await rehearseFile(entry);

        const encrypted = recipient ? encryptFile(entry.file, recipient) : null;
        const payload = encrypted ?? entry.file;
        const ext = encrypted ? ".sql.age" : ".sql";

        const key = await uploadFile({
          file: payload,
          at,
          dryRun: flags.dryRun,
          s3: flags.s3,
          ext,
        });
        console.log(`  ${entry.database} → r2://${BUCKET}/${key}`);

        // 上げたものを取り直す。dry-run のときは上げていないので飛ばす。
        // `--s3` 経路は wrangler を使わないため、読み戻しも行わない。
        if (!flags.dryRun && !flags.s3) {
          verifyUploaded({ key, localPath: payload, expectEncrypted: encrypted !== null });
        }
      }

      if (!recipient) {
        console.log("\n**平文で上げた。** --allow-plaintext が指定されている（runbook 12.11）。");
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
      const dir = flags.out ?? defaultOutDir("u18-restore-");
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

/**
 * **直接実行されたときだけ `main()` を呼ぶ。**
 *
 * この guard が無いと、`DATABASES` を読むためだけに import しても
 * `main()` が走り、`process.argv` を自分のコマンドライン引数として
 * 読んでしまう（`check-backup-freshness.mjs` からの import で実際に
 * 踏みかけた —— 引数の形が合わず `default:` 節に落ちて、この docblock を
 * 標準出力へ吐いて `process.exitCode = 1` にする）。
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nエラー: ${error.message}`);
    process.exitCode = 1;
  });
}
