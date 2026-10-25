// @ts-check
/**
 * Workers route の `/*` が**裸の接頭辞を拾わない**件を静的に捕まえる。
 *
 * ## 何が起きたか
 *
 * `auth.under18.dev/account/*` は `/account/` を拾うが **`/account` を
 * 拾わない**。後者は auth-worker の `auth.under18.dev/*` へ落ちて 404 に
 * なった。**利用者が URL バーに打つのはこちら**なので、アカウント画面の
 * 入口が本番で踏めない状態だった。
 *
 * 同じ形を #137 でも踏んでいる（`go.under18.dev/c/*` だけにしていたら
 * `https://go.under18.dev/` が 522 を返した）。**2 回目なので検査にする。**
 *
 * ## Worker 側の設定では直らない
 *
 * Hono の `strict: false`（#198）は末尾スラッシュの有無を同一視するが、
 * **リクエストが Worker に届いていない**ので効かない。route の解決は
 * Cloudflare 側で、Worker のコードより前にある。
 *
 * ## 何を検査するか
 *
 * `host/path/*` という形の pattern があるのに `host/path` が無ければ落とす。
 * ホスト全体（`host/*`）は対象外 —— あれは `https://host/` が `/` として
 * 届くので、裸の接頭辞という概念が無い。
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const appsDir = path.join(repoRoot, "apps");

function findWorkerConfigs() {
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ app: e.name, config: path.join(appsDir, e.name, "wrangler.jsonc") }))
    .filter((e) => existsSync(e.config));
}

async function loadWrangler(appDir) {
  const require = createRequire(pathToFileURL(path.join(appDir, "_")).href);
  return import(pathToFileURL(require.resolve("wrangler")).href);
}

/**
 * 設定ファイルに書かれている env の名前を拾う。
 *
 * **`unstable_readConfig` は env 解決済みの形しか返さない**（`config.env`
 * は空）。どの env があるかは生のファイルからしか分からない。列挙を
 * ハードコードすると env が増えたとき黙って対象から漏れるので、
 * ここで見つける（`check-service-bindings.mjs` が Worker を列挙せず
 * 走査しているのと同じ理由）。
 */
function envNamesOf(configPath) {
  const text = readFileSync(configPath, "utf8");
  // jsonc のコメントと末尾カンマを落として JSON として読む。
  const json = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    return Object.keys(JSON.parse(json).env ?? {});
  } catch {
    // 読めなければ env 無しとして扱う。既定 env は別途必ず見るので、
    // ここで落とさずに済む。pattern が 1 つも見つからなければ下で落ちる。
    return [];
  }
}

/** 解決済みの設定から route の pattern を集める。 */
function patternsOf(config) {
  return (config?.routes ?? [])
    .map((r) => (typeof r === "string" ? r : r?.pattern))
    .filter((p) => typeof p === "string");
}

const workers = findWorkerConfigs();

if (workers.length === 0) {
  console.error(
    "::error::No apps/*/wrangler.jsonc found, so no route pattern was checked. This is a bug in the check, not a clean repository.",
  );
  process.exit(1);
}

/** 全 Worker の pattern を 1 つの集合にする。裸の接頭辞は別の Worker が持っていてもよい。 */
const all = new Set();
for (const { app, config } of workers) {
  const { unstable_readConfig } = await loadWrangler(path.join(appsDir, app));
  // 既定 env と、ファイルに書かれている env すべて。
  for (const env of [undefined, ...envNamesOf(config)]) {
    const resolved = unstable_readConfig(env === undefined ? { config } : { config, env });
    for (const pattern of patternsOf(resolved)) all.add(pattern);
  }
}

if (all.size === 0) {
  // **「0 件を調べて問題なし」が一番まずい。** 設定の読み方が変わって
  // pattern を拾えなくなっても、検査は緑のまま本番だけが落ちる。
  // このリポジトリには本番 route が実在するので、0 件は検査の故障である。
  console.error(
    "::error::No route patterns were found in any apps/*/wrangler.jsonc, so nothing was checked. This is a bug in the check, not a clean repository.",
  );
  process.exit(1);
}

const problems = [];
for (const pattern of all) {
  if (!pattern.endsWith("/*")) continue;
  const bare = pattern.slice(0, -2);
  // `host/*`（ホスト全体）は対象外。`/` が裸の接頭辞にあたるが、
  // ブラウザは `https://host` を `https://host/` として送るので届く。
  if (!bare.includes("/")) continue;
  if (!all.has(bare)) problems.push({ pattern, bare });
}

if (problems.length > 0) {
  for (const { pattern, bare } of problems) {
    console.error(
      `::error::route "${pattern}" does not match the bare prefix "${bare}". ` +
        `Cloudflare's /* needs at least one more character, so "${bare}" falls through to a ` +
        `broader route (or 404s). Add { "pattern": "${bare}", ... } next to it.`,
    );
  }
  process.exit(1);
}

console.log(`route patterns: ${all.size} checked, every /* has its bare prefix`);
