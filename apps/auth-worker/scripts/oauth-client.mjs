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
 *     --redirect-uri https://auth.under18.dev/account/callback --first-party [--remote]
 *   node scripts/oauth-client.mjs disable --client-id u18-dashboard [--remote]
 *   node scripts/oauth-client.mjs list [--remote]
 *   node scripts/oauth-client.mjs seed-dev          # ローカル専用（下記）
 *
 * 既定は `--local`（miniflare のローカル D1）。本番へ当てるときだけ `--remote` を付ける。
 * `--dry-run` を付けると SQL を表示するだけで実行しない。レビューを挟みたいとき、
 * あるいは運用手順として SQL を記録に残したいときに使う。
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function runSql(sql, { remote, dryRun }) {
  if (dryRun) {
    console.log(sql);
    return;
  }
  // シェルを通さない。引数配列で渡すので、SQL に含まれる記号が解釈されない。
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", DATABASE_NAME, remote ? "--remote" : "--local", "--command", sql],
    { cwd: WORKER_DIR, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute が失敗した (exit ${result.status})`);
  }
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

/**
 * `client_secret` を 1 度だけ表示する。
 *
 * DB に入れるのはハッシュだけ（仕様書 7.1）。平文はこの出力にしか存在しないので、
 * 取り損ねたら再発行するしかない。これは不便ではなく仕様で、
 * 「後から誰でも読み出せる平文」を作らないための形。
 */
function generateSecret() {
  const secret = randomBytes(32).toString("base64url");
  return { secret, hash: createHash("sha256").update(secret, "utf8").digest("hex") };
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
    options.secretHash === undefined && options.type === "confidential" ? generateSecret() : null;
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

async function create(options) {
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
    console.log("");
    console.log(`  client_secret: ${credential.secret}`);
    console.log("");
    console.log("  この値はここにしか出ない。DB にはハッシュしか保存していない。");
    console.log("  クライアントへ渡したら、端末のスクロールバッファと履歴から消すこと。");
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
      secretHash:
        client.secret === null
          ? null
          : createHash("sha256").update(client.secret, "utf8").digest("hex"),
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
    default:
      console.error("使い方: node scripts/oauth-client.mjs <create|disable|list|seed-dev> [...]");
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`エラー: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
