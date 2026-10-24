#!/usr/bin/env node
/**
 * ID Token 署名鍵（ES256）の生成とローテーション（#14 / #23 / 仕様書 5.4・7.1）。
 *
 * 独自の鍵生成コードは書かない。Node の `node:crypto` に P-256 鍵ペアを作らせ、
 * JWK として書き出すだけ。鍵の寿命判定も書き直さず、Worker 本体が使う
 * `src/domain/services/signing-key-rotation.ts` をそのまま読み込む
 * （後述「なぜ判定を共有するのか」）。
 *
 *   node scripts/signing-key.mjs generate [--kid K] [--apply-local]
 *   node scripts/signing-key.mjs list     [--remote]
 *   node scripts/signing-key.mjs verify   [--remote] [--secret-file F]
 *   node scripts/signing-key.mjs register --kid K --public-jwk <json|@file> [--active-in 24h] [--remote]
 *   node scripts/signing-key.mjs activate --kid K [--remote]
 *   node scripts/signing-key.mjs retire   --kid K [--in 7d] [--remote]
 *
 * 既定は `--local`（miniflare のローカル D1）。本番へ当てるときだけ `--remote`。
 * `--dry-run` で SQL を表示するだけにできる。
 *
 * `generate` の出力は 3 つに分かれる。**この 3 つの行き先を取り違えないこと。**
 *
 * | 出力              | 行き先                               | 機密 |
 * | ----------------- | ------------------------------------ | ---- |
 * | `SIGNING_KEY_JWK` | Workers Secret / .dev.vars（`d` 入り）| Yes  |
 * | `public_jwk`      | `signing_key_metadata` テーブル       | No   |
 * | `kid`             | 上記 2 つを結び付ける名前             | No   |
 *
 * `public_jwk` 列に `d` を含む方を入れると、**JWKS 経由で秘密鍵を世界へ配る**ことになる。
 * 実装は `d` を落とす作りにしてあるが（`src/infrastructure/crypto/jose-signing-key.ts`）、
 * 入れないに越したことはない。`verify` はこの取り違えも検出する。
 *
 * ## なぜ本番 D1 を触るコマンドを足したのか（#23）
 *
 * 以前このスクリプトは `--apply-local` しか持たず、「本番の鍵投入は時間差のある
 * 手順なので 1 コマンドで済ませてよい操作ではない」と書いてあった。その判断自体は
 * 正しいが、結果として docs/runbook.md 4.2 は**手で組み立てる長い SQL の列**になり、
 * 「書いてあるが実行されない手順」になっていた。時刻列を秒で入れる・旧鍵の
 * `active_until` を更新し忘れる、といった取り違えが起きたときの被害は全 RP の
 * 検証失敗である。
 *
 * そこで、**手順を 1 コマンドに畳まず、ステップごとに 1 コマンドを与える**形にした。
 * `register`（先行公開）→ `activate`（署名の切り替え）→ `retire`（撤去予約）は
 * 別々のコマンドのままで、間に待ち時間が入る構造は変えていない。禁じているのは
 * 「rotate 1 発で全部やる」コマンドであって、各ステップを実行可能にすることではない。
 *
 * ## なぜ判定を Worker と共有するのか
 *
 * `verify` は `auditSigningKeySecret()` ——`JoseSigningKeyProvider` が署名の直前に
 * 呼ぶのと同じ関数—— を呼ぶ。検査を別コードで書くと「スクリプトは OK と言ったのに
 * Worker は署名できない」が起こりうる。同じ関数を通すので、`verify` の結論は
 * 「この Secret を入れたら Worker はこの kid で署名する」そのものになる。
 */

import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATABASE_NAME = "u18-identity";

/**
 * 旧鍵を JWKS に残す既定の猶予（`retires_at` − `active_until`）。
 *
 * **下限は「ID Token の最長寿命 + RP の JWKS キャッシュ」** で、
 * 5 分（`TokenLifetime.idTokenMs`）+ 24 時間 = 24 時間 5 分。
 * Access Token は不透明トークンになったので署名鍵と無関係（仕様書 §14.1 決定 5）、
 * Refresh Token は発行しない（仕様書 1.2）ため、これより長寿命の署名対象は無い。
 *
 * 既定を 7 日と下限より大きく取るのは、JWKS をディスクへ長期キャッシュする RP と、
 * 切り替え後に問題が出て旧鍵へ戻す場合の保険。旧鍵は `active_until` が過去なので、
 * この間 JWKS に載っていても新規署名には使われない。
 */
const DEFAULT_RETIRE_GRACE = "7d";
const MIN_RETIRE_GRACE_MS = 24 * 60 * 60 * 1000 + 5 * 60 * 1000;

/**
 * 新鍵を先行公開してから署名に使うまでの既定の待ち（`active_from` − now）。
 *
 * RP 側の JWKS キャッシュ TTL は u18 からは制御できず、一般的な OIDC
 * ライブラリの既定値は 5 分〜24 時間。最長側を見込む。
 */
const DEFAULT_PREPUBLISH = "24h";

/**
 * 署名を切り替えてから旧鍵の撤去を予約するまでの待ち（runbook 4.2 ステップ 5）。
 *
 * 旧 kid で署名された ID Token が自然失効するのを待つ。切り替えの瞬間に発行された
 * トークンの `exp` は 5 分後で、RP 側のクロックスキュー許容（よくある既定は 60 秒）と
 * 処理中のリクエストを見込んで倍の 10 分とする。以前の 15 分は Access Token が
 * JWT になりうる前提の見積もりで、不透明トークンに決まった時点で根拠を失っている
 * （仕様書 §14.1 決定 5）。
 */
const POST_SWITCH_WAIT = "10m";

/**
 * 鍵の寿命判定は Worker 側の実装をそのまま読み込む。
 *
 * ここでルールを書き直すと、スクリプトが「現役」と言う鍵で Worker が署名を
 * 拒否する（あるいはその逆）という形でずれが表面化する。原因は SQL を目視しても
 * 分からない。Node の型ストリップ（22.18 以降）で TypeScript をそのまま import する。
 */
async function loadDomain() {
  try {
    const [rotation, identifier] = await Promise.all([
      import(join(WORKER_DIR, "src/domain/services/signing-key-rotation.ts")),
      import(join(WORKER_DIR, "../../packages/domain/src/identifier.ts")),
    ]);
    return { ...rotation, ...identifier };
  } catch (error) {
    throw new Error(
      `TypeScript を直接読み込めなかった。Node 22.18 以降（型ストリップ対応）が要る: ${error}`,
    );
  }
}

/** SQL リテラル。値は運用者の手元からしか来ないが、`'` を含む JSON は普通にある。 */
function quote(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** `7d` / `24h` / `10m` / `0` を ms へ。epoch ミリ秒の列に入れるため。 */
function parseDuration(text) {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(String(text).trim());
  if (match === null) throw new Error(`期間の書式が違う（例: 7d, 24h, 10m, 0）: ${text}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return amount * factor;
}

function formatDuration(ms) {
  if (ms === 0) return "0（即時）";
  const days = ms / 86_400_000;
  if (Number.isInteger(days) && days >= 1) return `${days} 日`;
  const hours = ms / 3_600_000;
  if (Number.isInteger(hours) && hours >= 1) return `${hours} 時間`;
  return `${Math.round(ms / 60_000)} 分`;
}

function wrangler(args, { json = false } = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: WORKER_DIR,
    stdio: json ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`wrangler が失敗した (exit ${result.status})`);
  }
  return result.stdout ?? "";
}

function runSql(sql, { remote, dryRun }) {
  if (dryRun) {
    console.log(sql);
    return;
  }
  // シェルを通さない。引数配列で渡すので、SQL に含まれる記号が解釈されない。
  wrangler(["d1", "execute", DATABASE_NAME, remote ? "--remote" : "--local", "--command", sql]);
}

/**
 * `signing_key_metadata` の全行を読む。
 *
 * **時刻列は epoch ミリ秒の INTEGER**（`packages/db/src/schema/_shared.ts`）。
 * SQLite の `unixepoch()` は秒なので、書くときは必ず 1000 倍する。読むときは
 * そのまま `new Date()` に渡せる。この 1000 倍を忘れると 1970 年と解釈され、
 * 鍵のライフサイクル判定が全部狂う。
 */
function readRows(options) {
  const stdout = wrangler(
    [
      "d1",
      "execute",
      DATABASE_NAME,
      options.remote ? "--remote" : "--local",
      "--json",
      "--command",
      `select kid, algorithm, public_jwk, active_from, active_until, retires_at
       from signing_key_metadata order by active_from;`,
    ],
    { json: true },
  );

  const start = stdout.indexOf("[");
  if (start < 0) throw new Error(`wrangler の出力を JSON として読めなかった:\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(start));
  const results = Array.isArray(parsed) ? (parsed[0]?.results ?? []) : (parsed.results ?? []);

  return results.map((row) => ({
    kid: row.kid,
    algorithm: row.algorithm,
    publicJwk: row.public_jwk,
    activeFrom: new Date(row.active_from),
    activeUntil: row.active_until === null ? null : new Date(row.active_until),
    retiresAt: row.retires_at === null ? null : new Date(row.retires_at),
  }));
}

/**
 * 検査対象の Secret を読む。
 *
 * **本番の Secret は `wrangler secret` では読み出せない**（書き込み専用）。
 * したがって `--remote` の検査は「これから `wrangler secret put` する値」を
 * 運用者が渡す形になる。投入**前**に DB と突き合わせられるので、むしろこの順序が
 * 正しい —— 入れてから壊れていることに気付くのでは、気付く手段が RP からの
 * 問い合わせしかない。
 */
function readSecret(options) {
  if (options.secretFile !== undefined) {
    const raw =
      options.secretFile === "-"
        ? readFileSync(0, "utf8")
        : readFileSync(resolve(options.secretFile), "utf8");
    return {
      source: options.secretFile === "-" ? "標準入力" : options.secretFile,
      jwk: raw.trim(),
      kid: null,
    };
  }

  if (process.env["SIGNING_KEY_JWK"] !== undefined) {
    return {
      source: "環境変数 SIGNING_KEY_JWK",
      jwk: process.env["SIGNING_KEY_JWK"],
      kid: process.env["SIGNING_KEY_KID"] ?? null,
    };
  }

  if (options.remote === true) {
    // ローカルの .dev.vars を本番 DB と突き合わせても意味が無く、
    // 「一致しない」という誤った警告を出すだけなので拾わない。
    return null;
  }

  try {
    const text = readFileSync(join(WORKER_DIR, ".dev.vars"), "utf8");
    const read = (name) => {
      const match = new RegExp(`^${name}=(.*)$`, "m").exec(text);
      return match === null ? null : match[1].trim();
    };
    const jwk = read("SIGNING_KEY_JWK");
    return jwk === null ? null : { source: ".dev.vars", jwk, kid: read("SIGNING_KEY_KID") };
  } catch {
    return null;
  }
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
      case "--kid":
        options.kid = next();
        break;
      case "--public-jwk":
        options.publicJwk = next();
        break;
      case "--active-in":
        options.activeIn = next();
        break;
      case "--in":
        options.retireIn = next();
        break;
      case "--secret-file":
        options.secretFile = next();
        break;
      case "--apply-local":
        options.applyLocal = true;
        break;
      case "--remote":
        options.remote = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      default:
        throw new Error(`未知のオプション: ${arg}`);
    }
  }
  return options;
}

/** `--public-jwk @path` でファイルからも読めるようにする。JWK は 1 行が長い。 */
function readJwkArgument(value) {
  const raw = value.startsWith("@") ? readFileSync(resolve(value.slice(1)), "utf8") : value;
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("公開 JWK が JSON オブジェクトでない");
  if (typeof parsed.d === "string") {
    // ここで止めるのが `verify` より早い唯一の関門。入れてしまうと JWKS から
    // 秘密鍵が配られうる（実装は落とすが、DB に秘密鍵が載ること自体が事故）。
    throw new Error("公開 JWK に d が含まれている。秘密鍵を public_jwk へ入れようとしている");
  }
  return parsed;
}

function insertKeySql(kid, publicJwk, activeFromMs) {
  const activeFrom =
    activeFromMs === 0 ? "unixepoch() * 1000" : `(unixepoch() + ${activeFromMs / 1000}) * 1000`;
  return `insert into signing_key_metadata
     (kid, algorithm, public_jwk, active_from, active_until, retires_at, created_at)
   values (${quote(kid)}, 'ES256', ${quote(JSON.stringify(publicJwk))},
     ${activeFrom}, null, null, unixepoch() * 1000);`;
}

// --------------------------------------------------------------------------
// generate
// --------------------------------------------------------------------------

function generate(options) {
  // kid は日付入りにして、ローテーション時に既存の kid と衝突しないようにする。
  const kid = options.kid ?? `u18-${new Date().toISOString().slice(0, 10)}-1`;
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const meta = { alg: "ES256", use: "sig", kid };

  const privateJwk = { ...privateKey.export({ format: "jwk" }), ...meta };
  const publicJwk = { ...publicKey.export({ format: "jwk" }), ...meta };

  // 既にある鍵へ**足した** JWK Set を出す。置き換えではなく追加にするのが
  // #23 の要点で、新旧 2 本が同居している間だけ無停止の切り替えができる。
  const existing = options.applyLocal === true ? readSecret({ ...options, remote: false }) : null;
  const merged = mergeIntoJwkSet(existing, privateJwk, kid);

  console.log("# .dev.vars に貼る（本番は wrangler secret put SIGNING_KEY_JWK で入れる）");
  if (merged.addedTo > 0) {
    console.log(
      `# 既存の ${merged.addedTo} 本（${merged.kids.join(", ")}）に新しい鍵を足した JWK Set`,
    );
  }
  console.log(`SIGNING_KEY_JWK=${JSON.stringify(merged.set)}`);
  if (merged.droppedLegacyKid) {
    console.log("# SIGNING_KEY_KID は JWK Set 形式では使われない。.dev.vars から消してよい。");
  }
  console.log("");

  // `active_from` を過去にしておく。未来にすると「JWKS には出るが署名に使えない」
  // 先行公開の状態になり、ローカルで ID Token を発行できない（runbook 4.2 ステップ 2）。
  const activeIn = options.activeIn === undefined ? 0 : parseDuration(options.activeIn);
  const sql = insertKeySql(kid, publicJwk, activeIn);

  console.log("# signing_key_metadata に入れる公開鍵（機密ではない）");
  console.log(sql);

  if (options.applyLocal === true) {
    runSql(sql, { remote: false, dryRun: false });
    console.log("");
    console.log(`ローカル D1 に ${kid} の公開鍵を入れた。`);
  } else {
    console.log("");
    console.log("# 本番はこの SQL を直接流さず、次で入れる（取り違えの検査が入る）:");
    console.log(`#   node scripts/signing-key.mjs register --kid ${kid} \\`);
    console.log(`#     --public-jwk '${JSON.stringify(publicJwk)}' --remote`);
  }

  console.log("");
  console.log("この出力は端末のスクロールバッファとシェル履歴に残る。");
  console.log("設定が終わったら画面を消すこと（docs/runbook.md 2.4.1）。");
}

/** 既存の Secret（単一 JWK でも Set でも）に 1 本足した JWK Set を作る。 */
function mergeIntoJwkSet(existing, privateJwk, kid) {
  if (existing === null)
    return { set: { keys: [privateJwk] }, addedTo: 0, kids: [], droppedLegacyKid: false };

  let parsed;
  try {
    parsed = JSON.parse(existing.jwk);
  } catch {
    // 壊れた既存値を黙って捨てると、動いていた鍵が消えたことに気付けない。
    throw new Error(`${existing.source} の SIGNING_KEY_JWK を JSON として読めない。手で直すこと`);
  }

  const keys = Array.isArray(parsed?.keys)
    ? parsed.keys
    : // 単一 JWK 形式。kid が JWK に無ければ SIGNING_KEY_KID から補う。
      [{ ...parsed, kid: parsed.kid ?? existing.kid }];

  const kept = keys.filter(
    (key) =>
      typeof key?.d === "string" &&
      key.kid != null &&
      key.kid !== kid &&
      // .dev.vars.example の雛形をそのままコピーした場合の偽鍵を引き継がない。
      // 持ち越すと `verify` が「行の無い鍵」として延々と NG を出す。
      !String(key.kid).includes("REPLACE_ME"),
  );
  return {
    set: { keys: [...kept, privateJwk] },
    addedTo: kept.length,
    kids: kept.map((key) => key.kid),
    droppedLegacyKid: existing.kid !== null,
  };
}

// --------------------------------------------------------------------------
// list / verify
// --------------------------------------------------------------------------

const STATE_LABEL = {
  signing: "署名中",
  "not-yet-active": "先行公開（まだ署名しない）",
  "no-longer-signing": "署名停止（JWKS には残る）",
  retired: "撤去済み（JWKS から消えている）",
};

function formatTime(date) {
  return date === null ? "—" : date.toISOString().replace(".000Z", "Z");
}

async function list(options) {
  const domain = await loadDomain();
  const rows = readRows(options);
  if (rows.length === 0) {
    console.log("signing_key_metadata に行が無い。JWKS は 503 を返し、ID Token も発行できない。");
    return;
  }

  const secret = readSecret(options);
  const secretKids =
    secret === null
      ? null
      : new Set(domain.parseSigningKeySecret(secret.jwk, secret.kid).keys?.map((k) => k.kid) ?? []);

  const now = new Date();
  console.log(`現在時刻: ${formatTime(now)}`);
  if (secret !== null) console.log(`Secret の出どころ: ${secret.source}`);
  console.log("");
  for (const row of rows) {
    const state = domain.signingKeyState(row, now);
    const held =
      secretKids === null ? "" : secretKids.has(row.kid) ? "  [秘密鍵あり]" : "  [秘密鍵なし]";
    console.log(`${row.kid}  ${STATE_LABEL[state]}${held}`);
    console.log(
      `    active_from=${formatTime(row.activeFrom)}  active_until=${formatTime(row.activeUntil)}  retires_at=${formatTime(row.retiresAt)}`,
    );
  }
}

/**
 * Secret と `signing_key_metadata` の整合を検査する（#23 (c)）。
 *
 * **`/health` には足していない。** 足すと鍵未設定の環境で `/health` が落ち、
 * #53 で解消したばかりの「設定不備が無関係なエンドポイントを巻き込む」構造を
 * そのまま再導入することになる。`UnconfiguredEmailSender` /
 * `UnconfiguredIpHasher` と同じく、失敗は**使おうとした時点**（署名時）に置き、
 * 事前の確認はこのコマンドで行う。
 */
async function verify(options) {
  const domain = await loadDomain();
  const secret = readSecret(options);
  if (secret === null) {
    throw new Error(
      options.remote === true
        ? "検査する Secret が無い。本番の Secret は読み出せないので、投入予定の値を --secret-file か環境変数 SIGNING_KEY_JWK で渡すこと"
        : ".dev.vars に SIGNING_KEY_JWK が無い。先に key:generate を実行すること",
    );
  }

  console.log(`Secret の出どころ: ${secret.source}`);
  console.log(`DB: ${options.remote === true ? "--remote（本番）" : "--local"}`);
  console.log("");

  const parsed = domain.parseSigningKeySecret(secret.jwk, secret.kid);
  if (!parsed.ok) {
    console.error(`NG: ${parsed.reason}`);
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const audit = domain.auditSigningKeySecret(parsed.keys, readRows(options), now);

  console.log(`Secret に入っている kid: ${audit.secretKids.join(", ")}`);
  console.log(
    audit.signingKid === null
      ? "新規署名に使える鍵: **無し**"
      : `新規署名に使われる kid: ${audit.signingKid}`,
  );
  console.log("");

  const fatal = audit.issues.filter((issue) => domain.isMisconfiguration(issue.problem));
  const expected = audit.issues.filter((issue) => !domain.isMisconfiguration(issue.problem));

  for (const issue of expected) {
    // ローテーション中に見えて当然のもの。異常として出すと誰も読まなくなる。
    console.log(`情報: ${issue.detail}`);
  }
  for (const issue of fatal) {
    console.error(`NG: ${issue.detail}`);
  }

  if (fatal.length > 0 || audit.signingKid === null) {
    console.error("");
    console.error(
      audit.signingKid === null
        ? "この Secret では ID Token を発行できない。docs/runbook.md 4 を参照。"
        : // 署名は続くが、上の NG は手順のどこにも現れない状態である。
          `署名自体は ${audit.signingKid} で続く。ただし上の NG は運用ミスなので直すこと（docs/runbook.md 4）。`,
    );
    process.exitCode = 1;
    return;
  }

  console.log("OK: Secret と signing_key_metadata は整合している。");
}

// --------------------------------------------------------------------------
// register / activate / retire（runbook 4.2 のステップ 2 / 4 / 7）
// --------------------------------------------------------------------------

async function register(options) {
  if (!options.kid) throw new Error("--kid は必須");
  if (!options.publicJwk) throw new Error("--public-jwk は必須（generate の出力をそのまま渡す）");

  const publicJwk = readJwkArgument(options.publicJwk);
  const activeIn = parseDuration(options.activeIn ?? DEFAULT_PREPUBLISH);

  const rows = options.dryRun === true ? [] : readRows(options);
  if (rows.some((row) => row.kid === options.kid)) {
    throw new Error(`kid ${options.kid} は既に登録されている`);
  }

  runSql(insertKeySql(options.kid, { ...publicJwk, kid: options.kid }, activeIn), options);

  console.log("");
  console.log(
    `${options.dryRun === true ? "dry-run: " : ""}${options.kid} を登録した。` +
      `${formatDuration(activeIn)}後から署名に使える（それまでは JWKS に出るだけ）。`,
  );
  if (activeIn > 0) {
    console.log("");
    console.log("先行公開する理由: RP は JWKS をキャッシュしており、未知の kid を持つ");
    console.log("ID Token が届いたとき、再取得せずに検証失敗にする実装がある。署名を");
    console.log("切り替える前に、全 RP が新しい公開鍵を持っている状態を作る。");
  }
  console.log("");
  console.log(
    `次: 秘密鍵を Secret の JWK Set に足す → node scripts/signing-key.mjs verify${options.remote ? " --remote" : ""}`,
  );
}

/**
 * 署名を新しい kid へ切り替える（runbook 4.2 ステップ 4）。
 *
 * **Secret を触らない。** 旧実装では Secret 2 本の置き換えが切り替えそのもので、
 * 更新のあいだに「旧 kid を名乗る新鍵署名」が発行される窓があった。JWK Set に
 * 新旧が同居していれば、切り替えは下の UPDATE だけで完結し、その窓が消える。
 */
async function activate(options) {
  if (!options.kid) throw new Error("--kid は必須");
  const domain = await loadDomain();
  const rows = readRows(options);

  const target = rows.find((row) => row.kid === options.kid);
  if (target === undefined) {
    // 先に旧鍵を止めてしまうと、引き継ぐ鍵が無いまま署名が全面停止する。
    throw new Error(`kid ${options.kid} が signing_key_metadata に無い。先に register すること`);
  }

  const secret = readSecret(options);
  if (secret === null) {
    console.warn(
      "警告: 検査できる Secret が無い。切り替え前に verify --secret-file で確認すること。",
    );
  } else {
    // (c) の検査を、一番効く瞬間 —— 切り替える直前 —— に挟む。ここで
    // 不一致を見逃すと、UPDATE の直後から全 RP で ID Token の検証が失敗する。
    const parsed = domain.parseSigningKeySecret(secret.jwk, secret.kid);
    if (!parsed.ok) throw new Error(`${secret.source}: ${parsed.reason}`);
    const audit = domain.auditSigningKeySecret(parsed.keys, rows, new Date());
    const blocking = audit.issues.filter(
      (issue) => issue.kid === options.kid && issue.problem !== "not-yet-active",
    );
    if (!audit.secretKids.includes(options.kid)) {
      blocking.push({
        kid: options.kid,
        problem: "missing-from-secret",
        detail: `kid "${options.kid}" が ${secret.source} の SIGNING_KEY_JWK に無い`,
      });
    }
    if (blocking.length > 0 && options.force !== true) {
      for (const issue of blocking) console.error(`NG: ${issue.detail}`);
      throw new Error(
        "切り替えを中止した。Secret を直してから再実行すること（--force で強行できる）",
      );
    }
  }

  // UPDATE が止める鍵と、監査ログに書く鍵を同じ条件で求める。別々に書くと、
  // 「ログ上は交代していないのに止まっている鍵」が出る。
  const now = new Date();
  const replaced = rows.filter(
    (row) => row.kid !== options.kid && domain.signingKeyState(row, now) === "signing",
  );

  const sql = [
    // 現役の鍵だけを止める。`active_from` が未来の鍵（別の先行公開）まで
    // 巻き込むと、まだ始まってもいない鍵が「終わった」ことになる。
    `update signing_key_metadata set active_until = unixepoch() * 1000
       where active_until is null and active_from <= unixepoch() * 1000 and kid <> ${quote(options.kid)};`,
    `update signing_key_metadata set active_from = unixepoch() * 1000
       where kid = ${quote(options.kid)} and active_from > unixepoch() * 1000;`,
    // 鍵の交代は後から追える必要がある（#23 の監査ログ要件）。秘密は入れない。
    `insert into audit_logs (id, event, user_id, actor, outcome, reason, metadata, ip_hash, user_agent, created_at)
     values (${quote(domain.newId("aud"))}, 'signing_key.rotated', null, 'scripts/signing-key.mjs',
       'success', null, ${quote(JSON.stringify({ kid: options.kid, replaced: replaced.map((row) => row.kid) }))},
       null, null, unixepoch() * 1000);`,
  ].join("\n");

  runSql(sql, options);

  console.log("");
  console.log(
    `${options.dryRun === true ? "dry-run: " : ""}署名鍵を ${options.kid} へ切り替えた。`,
  );
  console.log("");
  console.log(
    `次: ${formatDuration(parseDuration(POST_SWITCH_WAIT))}待って（旧 kid の ID Token が自然失効する）、`,
  );
  console.log(
    `    node scripts/signing-key.mjs retire --kid <旧 kid>${options.remote ? " --remote" : ""}`,
  );
}

async function retire(options) {
  if (!options.kid) throw new Error("--kid は必須");
  const grace = parseDuration(options.retireIn ?? DEFAULT_RETIRE_GRACE);

  if (grace < MIN_RETIRE_GRACE_MS && options.force !== true) {
    // 猶予を縮めるのは緊急時（鍵漏洩）だけの判断で、代償は「JWKS を再取得しない
    // RP で検証失敗が出る」こと。事故で短くするのと、意図して短くするのを区別する。
    throw new Error(
      `猶予 ${formatDuration(grace)} は下限（ID Token 5 分 + JWKS キャッシュ 24 時間）を下回る。` +
        "鍵漏洩への対応なら docs/runbook.md 5.1 に従い --force を付けること",
    );
  }

  const rows = options.dryRun === true ? [] : readRows(options);
  const target = rows.find((row) => row.kid === options.kid);
  if (options.dryRun !== true && target === undefined) {
    throw new Error(`kid ${options.kid} が signing_key_metadata に無い`);
  }
  if (target !== undefined && target.activeUntil === null && options.force !== true) {
    // 現役の鍵に撤去予定を入れると、JWKS から消えた鍵で署名し続ける状態になる。
    throw new Error(
      `kid ${options.kid} はまだ現役（active_until が null）。先に別の鍵へ activate すること`,
    );
  }

  const retiresAt = grace === 0 ? "unixepoch() * 1000" : `(unixepoch() + ${grace / 1000}) * 1000`;
  runSql(
    `update signing_key_metadata set retires_at = ${retiresAt} where kid = ${quote(options.kid)};`,
    options,
  );

  console.log("");
  console.log(
    `${options.dryRun === true ? "dry-run: " : ""}${options.kid} を ${formatDuration(grace)}後に JWKS から外す。`,
  );
  console.log("");
  console.log("retires_at を過ぎた時点で JWKS から自動的に消える（listPublishable が除外する）。");
  console.log(
    "行の DELETE は掃除にすぎず、公開状態には影響しない。Secret からもこの鍵を外すこと。",
  );
}

// --------------------------------------------------------------------------

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);

  switch (command) {
    case "generate":
      generate(options);
      break;
    case "list":
      await list(options);
      break;
    case "verify":
      await verify(options);
      break;
    case "register":
      await register(options);
      break;
    case "activate":
      await activate(options);
      break;
    case "retire":
      await retire(options);
      break;
    default:
      console.error(
        "使い方: node scripts/signing-key.mjs <generate|list|verify|register|activate|retire> [...]",
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
