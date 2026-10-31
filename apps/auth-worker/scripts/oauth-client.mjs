#!/usr/bin/env node
/**
 * OAuth クライアントの内部管理 CLI（#13 / 仕様書 1.2）。
 *
 * MVP に公開 Developer Portal は無い。
 *
 * **登録 API を公開しない理由。** 登録を誰でも叩けるようにすると、
 * 「任意の redirect_uri を持つクライアントを誰でも作れる」状態になる。
 * 認可コードの宛先を攻撃者が自分で登録できるということなので、
 * Redirect URI の完全一致検証（`src/domain/services/redirect-uri.ts`）が
 * 無意味になる。**叩ける場所を狭く保つこと自体が緩和策**である。
 *
 * ## 2026-10-29: 緩和策を置き換えた（#308）
 *
 * 運用者の判断で、緩和策を**「運用者の手元からしか叩けない」から
 * 「管理者（`users.is_admin`）だけが叩ける」へ置き換えた。** 登録・一覧・
 * 失効は `IdentityRPC.createOAuthClient` / `listOAuthClients` /
 * `disableOAuthClient` からも行える（判定は
 * `src/application/use-cases/admin-access.ts`）。
 *
 * **これは弱くなる方向の変更である。** 何が弱くなったかは
 * `docs/threat-model.md` の RR-21 に書いてある。上の段落は「狭く保つ」
 * という形で依然有効で、変わったのは狭さの定義だけ。
 *
 * **このスクリプトは消さない。** 理由は 3 つ。(1) **管理者が 0 人のときの
 * 唯一の入口**で、実際いま本番の管理者は 0 人である（最初の 1 人は
 * ここからしか作れない）。(2) **一次パーティの登録と失効はここにしか無い**
 * —— 同意画面の省略は「登録できること」とは別の、より重い権限なので
 * RPC の入力に項目ごと置いておらず、止めるほうも RPC からは `conflict` に
 * なる（`u18-dashboard` を止められると u18 全サービスのログインが落ちる）。
 * (3) RPC 側は `http://localhost` を登録できないので、`seed-dev` の
 * 代わりにならない。
 *
 * 使い方:
 *
 *   node scripts/oauth-client.mjs create \
 *     --client-id u18-dashboard --name "u18 Dashboard" --type confidential \
 *     --redirect-uri https://auth.under18.dev/account/callback --first-party \
 *     --out secret.txt [--remote]          # confidential には --out が必須
 *   node scripts/oauth-client.mjs disable --client-id u18-dashboard [--remote]
 *   node scripts/oauth-client.mjs list [--remote]
 *   node scripts/oauth-client.mjs seed-dev          # ローカル専用（下記）
 *   node scripts/oauth-client.mjs generate-secret --out secret.txt
 *   node scripts/oauth-client.mjs rotate --client-id u18-admin --secret-file secret.txt [--remote]
 *
 * 既定は `--local`（miniflare のローカル D1）。本番へ当てるときだけ `--remote` を付ける。
 * `--dry-run` を付けると SQL を表示するだけで実行しない。レビューを挟みたいとき、
 * あるいは運用手順として SQL を記録に残したいときに使う。
 *
 * ## 2026-10-31: 秘密を回す手段を足した（#445）
 *
 * `client_secret` が平文で人の目に触れる経路を通った。**ところが回す
 * 手段が無かった。** `create` しか無く、`client_id` に一意制約がある
 * ので作り直しもできない——漏れても差し替えられない状態そのものが穴
 * だった。
 *
 * **`generate-secret` と `rotate` を分けてある。** 「生成 → D1 を UPDATE →
 * ファイルに書く」を 1 コマンドにまとめると、新しい秘密を
 * `wrangler secret put` で Worker 側へ入れる**前**に D1 が書き変わって
 * しまい、「先に Worker へ入れてから D1 を更新する」という順序を踏む
 * 余地が無くなる。`signing-key.mjs` が `generate`（ローカルだけ）と
 * `register`（本番の反映）を分けているのと同じ理由（あちらの
 * 「なぜ本番 D1 を触るコマンドを足したのか」を参照——禁じているのは
 * 「1 発で全部やる」コマンドであって、各ステップを実行可能にすることではない）。
 *
 * **猶予期間は持たない。** `secret_hash_previous` のような列を増やす
 * 設計も検討したが、落ちる相手はクライアント 1 つ・運用者 1 人の管理画面
 * だけなので、「手順書に『新旧どちらを先に入れても、もう片方が終わるまで
 * の間は必ず落ちる』と書く」ほうが安い（運用者の判断、2026-10-31）。
 * `generate-secret` の出力がその手順を案内する。
 *
 * **`create` も直した。** 今夜の秘密が人の目に触れたのは、回す手段が
 * 無かったことだけでなく、`create` が平文を `console.log` に出していた
 * ことが本体だった——回す手段だけ足しても、同じ経路で同じことがもう一度
 * 起こせる。confidential クライアントの作成は `--out` を必須にし、
 * `writeSecretFile` でファイルへ書いてパスだけ表示する形に変えた。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRotationEligibility,
  generateClientSecret,
  hashClientSecret,
  isValidClientSecretFormat,
  writeSecretFile,
} from "./lib/client-secret.ts";
import { describeWranglerFailure } from "./lib/wrangler-failure.ts";

const WORKER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATABASE_NAME = "u18-identity";

/**
 * 検証と ID 生成は Worker 側の実装をそのまま読み込む。
 *
 * ここでルールを書き直すと、登録時に通した URI が認可時に弾かれる（あるいはその逆）
 * という形でずれが表面化する。原因は URL を目視しても分からない。
 * Node の型ストリップ（22.18 以降）で TypeScript をそのまま import する。
 */
async function loadDomain() {
  try {
    const [redirectUri, identifier] = await Promise.all([
      import(join(WORKER_DIR, "src/domain/services/redirect-uri.ts")),
      import(join(WORKER_DIR, "../../packages/domain/src/identifier.ts")),
    ]);
    return { ...redirectUri, ...identifier };
  } catch (error) {
    throw new Error(
      `TypeScript を直接読み込めなかった。Node 22.18 以降（型ストリップ対応）が要る: ${error}`,
    );
  }
}

/** SQL リテラル。値は運用者の手元からしか来ないが、`'` を含む名前は普通にある。 */
function quote(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * wrangler を呼ぶ。
 *
 * **`--json` を付けた wrangler は、エラーを stdout に JSON で書く。
 * stderr は空である**（`admin-role.mjs` / `lib/wrangler-failure.ts` で
 * 実測済み）。`json` のとき stdout を pipe で捕まえるので、失敗したときに
 * それを捨てると原因がどこにも残らない——`describeWranglerFailure` に
 * 渡して伝える。
 */
function wrangler(args, { json = false } = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: WORKER_DIR,
    stdio: json ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      describeWranglerFailure({
        status: result.status,
        stdout: result.stdout,
        remote: args.includes("--remote"),
      }),
    );
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

/** 結果の行を読む。`rotate` の対象確認（#445）に使う。 */
function querySql(sql, { remote }) {
  const stdout = wrangler(
    ["d1", "execute", DATABASE_NAME, remote ? "--remote" : "--local", "--json", "--command", sql],
    { json: true },
  );
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error(`wrangler の出力を JSON として読めなかった:\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(start));
  return Array.isArray(parsed) ? (parsed[0]?.results ?? []) : (parsed.results ?? []);
}

function parseArgs(argv) {
  const options = { redirectUris: [], scopes: "openid profile email" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} に値が無い`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--client-id":
        options.clientId = next();
        break;
      case "--name":
        options.name = next();
        break;
      case "--type":
        options.type = next();
        break;
      case "--redirect-uri":
        options.redirectUris.push(next());
        break;
      case "--scopes":
        options.scopes = next();
        break;
      case "--logo-url":
        options.logoUrl = next();
        break;
      case "--first-party":
        options.firstParty = true;
        break;
      case "--allow-loopback-http":
        options.allowLoopbackHttp = true;
        break;
      case "--out":
        options.out = next();
        break;
      case "--secret-file":
        options.secretFile = next();
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

function insertStatements(domain, options) {
  const { newClientId, validateRedirectUriForRegistration } = domain;

  if (!options.clientId) throw new Error("--client-id は必須");
  if (!options.name) throw new Error("--name は必須");
  if (options.type !== "confidential" && options.type !== "public") {
    throw new Error("--type は confidential か public");
  }
  if (options.redirectUris.length === 0) {
    // Redirect URI を持たないクライアントは認可フローに入れない。
    // 「後で足す」を許すと、未検証の URI が直接 SQL で入る経路ができる。
    throw new Error("--redirect-uri を 1 つ以上指定すること");
  }

  const validated = options.redirectUris.map((uri) => {
    const result = validateRedirectUriForRegistration(uri, {
      allowLoopbackHttp: options.allowLoopbackHttp === true,
    });
    if (!result.ok) {
      throw new Error(`redirect_uri を登録できない (${result.reason}): ${uri}`);
    }
    return result.uri;
  });

  if (options.remote && options.allowLoopbackHttp) {
    // 本番 IdP に http://localhost の宛先が残っていると、その client_id を知る
    // 攻撃者が被害者のブラウザで認可を走らせ、自分の手元で待つアプリへ
    // コードを届けられる（redirect-uri.ts のコメント参照）。
    throw new Error("--allow-loopback-http は --remote と併用できない");
  }

  // 内部 ID は呼び出し側が固定できる。seed-dev は固定 ID を使って
  // 「何度流しても同じ状態」にする（下記）。通常の登録では毎回新しく振る。
  const id = options.id ?? newClientId();
  // ハッシュを外から渡せるのも seed-dev のためだけ。通常は必ず新しい秘密を作る。
  const credential =
    options.secretHash === undefined && options.type === "confidential"
      ? generateClientSecret()
      : null;
  const secretHash = options.secretHash ?? credential?.hash ?? null;

  // seed は再実行されうるので、既にあれば黙って飛ばす。通常の登録では
  // `insert into` のまま unique index に衝突させ、二重登録を失敗として見せる。
  const insert = options.ifNotExists === true ? "insert or ignore into" : "insert into";

  const statements = [
    `${insert} oauth_clients
       (id, client_id, name, client_type, client_secret_hash, allowed_scopes,
        is_first_party, logo_url, created_at, updated_at)
     values (${quote(id)}, ${quote(options.clientId)}, ${quote(options.name)},
       ${quote(options.type)}, ${quote(secretHash)}, ${quote(options.scopes)},
       ${quote(options.firstParty === true)}, ${quote(options.logoUrl ?? null)},
       unixepoch() * 1000, unixepoch() * 1000);`,
    ...validated.map(
      (uri, index) =>
        `${insert} oauth_redirect_uris (id, client_id, uri, created_at)
         values (${quote(`uri_${id}_${index}`)}, ${quote(id)}, ${quote(uri)}, unixepoch() * 1000);`,
    ),
  ];

  return { id, credential, statements };
}

/**
 * **confidential クライアントの作成には `--out` が必須。**
 *
 * 以前はここで `console.log` に平文の秘密をそのまま出していた。
 * `client_secret` が平文で人の目に触れた経路はまさにここで、#445 の
 * 発端になった（回す手段を足しても、ここが開いたままでは同じことが
 * もう一度起こせる）。`writeSecretFile`（`rotate` / `generate-secret` と
 * 同じ関数）でファイルへ書き、パスだけを表示する。
 */
async function create(options) {
  if (options.type === "confidential" && !options.out) {
    throw new Error(
      "--out は必須（confidential クライアントの作成）。新しい秘密を標準出力に出さないため、" +
        "書き出し先のファイルパスを指定すること。public クライアントには secret が無いので不要",
    );
  }

  const domain = await loadDomain();
  const { id, credential, statements } = insertStatements(domain, options);

  // client_id の二重登録は unique index が止める。先に SELECT で確認する形にすると、
  // 2 本同時に走ったときに両方が「無い」と判断しうる。
  runSql(statements.join("\n"), options);

  console.log("");
  console.log(
    options.dryRun
      ? `dry-run: 上の SQL を流せば client_id=${options.clientId} (内部 ID ${id}) が登録される`
      : `登録した: client_id=${options.clientId} (内部 ID ${id})`,
  );
  if (credential !== null) {
    if (options.dryRun) {
      console.log("");
      console.log(`  dry-run: 実行すれば新しい秘密が生成され、${options.out} に書かれる`);
      return;
    }
    writeSecretFile(options.out, credential.secret);
    console.log("");
    console.log(`  新しい秘密はここに書いた: ${options.out}`);
    console.log("  この値はここにしか無い。DB にはハッシュしか保存していない。");
    console.log(
      `  Worker へ渡したら（wrangler secret put <NAME> < ${options.out}）、ファイルを消すこと。`,
    );
  }
}

async function disable(options) {
  if (!options.clientId) throw new Error("--client-id は必須");
  // `disabled_at is null` を条件に入れて、二重失効で時刻が上書きされるのを防ぐ。
  // 失効は即座に効く（findByClientId が行を返しても UseCase が拒否する）。
  runSql(
    `update oauth_clients set disabled_at = unixepoch() * 1000, updated_at = unixepoch() * 1000
     where client_id = ${quote(options.clientId)} and disabled_at is null;`,
    options,
  );
  console.log(
    options.dryRun
      ? `dry-run: 上の SQL を流せば client_id=${options.clientId} が失効する`
      : `失効させた: client_id=${options.clientId}`,
  );
}

/**
 * 新しい `client_secret` をファイルへ書く（#445）。**D1 には触れない。**
 *
 * 生成と適用（`rotate`）を分けてある理由はファイル冒頭の #445 の節を参照。
 */
function generateSecretSteps(options) {
  if (!options.out) {
    throw new Error(
      "--out は必須。新しい秘密を標準出力に出さないため、書き出し先のファイルパスを指定すること",
    );
  }

  const { secret } = generateClientSecret();
  writeSecretFile(options.out, secret);

  console.log(`書いた: ${options.out}`);
  console.log("");
  console.log("次の 2 つを、間を空けずに実行すること:");
  console.log(
    `  npx wrangler secret put <NAME> --config <worker 側の wrangler.jsonc> < ${options.out}`,
  );
  console.log(
    `  node scripts/oauth-client.mjs rotate --client-id <ID> --secret-file ${options.out} [--remote]`,
  );
  console.log("");
  console.log(
    "どちらを先にしても、もう片方が終わるまでの間はそのクライアントが" +
      " invalid_client を返し続ける（猶予期間を持たない設計）。先に進める前に" +
      " 両方のコマンドを手元に用意しておくこと。",
  );
  console.log("");
  console.log(`両方終わったら ${options.out} を消すこと。`);
}

/**
 * `generate-secret` が書いたファイルの中身を D1 の `client_secret_hash` へ
 * 反映する（#445）。**ここでは新しい秘密を作らない。**
 */
async function rotate(options) {
  if (!options.clientId) throw new Error("--client-id は必須");
  if (!options.secretFile) {
    throw new Error(
      "--secret-file は必須。先に `generate-secret --out <path>` で作ったファイルを渡すこと",
    );
  }

  // 対象が存在し、confidential で、失効していないことを先に確かめる。
  // 飛ばすと、client_id の打ち間違いや public クライアントの指定が
  // 「0 行更新」という地味な結果にしかならず、見落とされる。
  // **この SELECT は --dry-run でも実行する。** 読み取りだけなので D1 を
  // 変更しないが、「--dry-run は D1 へ一切触れない」と理解していると
  // 食い違う。
  const rows = querySql(
    `select client_type, disabled_at from oauth_clients where client_id = ${quote(options.clientId)};`,
    options,
  );
  const eligibility = checkRotationEligibility(options.clientId, rows[0]);
  if (!eligibility.ok) throw new Error(eligibility.reason);

  // ファイルの中身をそのままハッシュ化する。trim しない —— `wrangler secret
  // put <NAME> < file` も同じファイルをそのまま読むので、両者が読む中身を
  // 完全に一致させることで「ハッシュは合っているのに Worker が送る値だけ
  // 違う」という今夜すでに 1 時間溶かした不一致を防ぐ。
  const secret = readFileSync(resolve(options.secretFile), "utf8");

  // 中身の形を検査する。trim して救わない——救うと「ファイルの中身と
  // wrangler secret put が送る値は完全に一致する」という設計の前提が
  // 崩れる。空ファイル（誰でも知っている定数ハッシュが D1 に入り、
  // client_secret に空文字を送れば認証が通る状態になる）や末尾の改行
  // （エディタで開いて保存しただけで付く）を、ここで弾く。
  if (!isValidClientSecretFormat(secret)) {
    throw new Error(
      `${options.secretFile} の中身が generate-secret の出力の形（base64url 43 文字）と違う。` +
        " 空ファイル・末尾の改行・手で貼り直した値などが考えられる。" +
        " generate-secret からやり直すこと（trim して通すことはしない）。",
    );
  }
  const hash = hashClientSecret(secret);

  runSql(
    `update oauth_clients set client_secret_hash = ${quote(hash)}, updated_at = unixepoch() * 1000
     where client_id = ${quote(options.clientId)} and client_type = 'confidential' and disabled_at is null;`,
    options,
  );

  console.log("");
  if (options.dryRun) {
    console.log(`dry-run: 上の SQL を流せば client_id=${options.clientId} の秘密が入れ替わる`);
    return;
  }
  console.log(`回した: client_id=${options.clientId}`);
  console.log("");
  console.log(
    `D1 は ${options.secretFile} の中身しか受け付けない。まだ wrangler secret put` +
      " していなければ今すぐ実行すること（このクライアントは invalid_client を返し続けている）。",
  );
}

function list(options) {
  runSql(
    `select c.client_id, c.name, c.client_type, c.is_first_party,
            c.disabled_at, group_concat(u.uri, ' ') as redirect_uris
     from oauth_clients c
     left join oauth_redirect_uris u on u.client_id = c.id
     group by c.id order by c.created_at;`,
    options,
  );
}

/**
 * ローカル開発と E2E 用のシードクライアント（#13 受け入れ条件）。
 *
 * **2 つ登録するのは SSO の検証に要るため。** 1 つのブラウザセッションで
 * 複数のクライアントに連続してログインできることを確かめるには、
 * 独立した client_id が 2 つ必要になる。
 *
 * **秘密がこのファイルに書いてあるのは、ローカル D1 にしか入れないから。**
 * `--remote` は受け付けない。本番のクライアントは `create` で登録し、
 * 生成された secret を 1 度だけ受け取ること。
 */
const DEV_CLIENTS = [
  {
    // 内部 ID を固定する。seed を 2 度流しても行が増えないようにするため
    // （ランダム ID だと、client_id 側は unique で弾かれるのに
    //  redirect_uri 側だけ存在しない内部 ID を指す行が残る）。
    id: "cli_dev_dashboard",
    clientId: "u18-dashboard-local",
    name: "u18 Dashboard (local)",
    type: "confidential",
    firstParty: true,
    secret: "dev-only-secret-dashboard",
    // 本番では dashboard は auth と同一ホストの /account/* に載る（#33）。
    // ローカルは Worker が別プロセスなのでポートで分かれる。
    redirectUris: ["http://localhost:8788/account/callback"],
  },
  {
    id: "cli_dev_e2e",
    clientId: "u18-e2e-local",
    name: "u18 E2E Client (local)",
    type: "public",
    firstParty: false,
    secret: null,
    // public クライアントは secret を持たず PKCE だけで認証する（仕様書 5.1）。
    redirectUris: ["http://localhost:8789/cb"],
  },
];

async function seedDev(options) {
  if (options.remote) {
    throw new Error("seed-dev はローカル専用。固定の秘密を本番へ入れないこと");
  }
  const domain = await loadDomain();

  for (const client of DEV_CLIENTS) {
    const { statements } = insertStatements(domain, {
      id: client.id,
      clientId: client.clientId,
      name: client.name,
      type: client.type,
      firstParty: client.firstParty,
      redirectUris: client.redirectUris,
      scopes: "openid profile email",
      // ループバックの http を許すのはここだけ。本番登録では使えない。
      allowLoopbackHttp: true,
      // 固定の秘密をそのままハッシュ化して入れる。create と違い新しい秘密を作らない
      // （E2E が決め打ちで使えないと意味がない）。
      secretHash: client.secret === null ? null : hashClientSecret(client.secret),
      ifNotExists: true,
    });
    runSql(statements.join("\n"), options);
  }

  console.log("");
  console.log(options.dryRun ? "dry-run: 投入される内容" : "シードしたローカル用クライアント:");
  for (const client of DEV_CLIENTS) {
    console.log(`  ${client.clientId} (${client.type})`);
    console.log(`    redirect_uri: ${client.redirectUris.join(" ")}`);
    if (client.secret !== null) console.log(`    client_secret: ${client.secret}`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  // 入力の不備は「使い方の誤り」なので、スタックトレースではなく
  // 何を直せばよいかだけを出す（redirect_uri の拒否理由もここに出る）。
  const options = parseArgs(rest);

  switch (command) {
    case "create":
      await create(options);
      break;
    case "disable":
      await disable(options);
      break;
    case "list":
      list(options);
      break;
    case "seed-dev":
      await seedDev(options);
      break;
    case "generate-secret":
      generateSecretSteps(options);
      break;
    case "rotate":
      await rotate(options);
      break;
    default:
      console.error(
        "使い方: node scripts/oauth-client.mjs <create|disable|list|seed-dev|generate-secret|rotate> [...]",
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
