// @ts-check
/**
 * `apps/*\/wrangler.jsonc` を見つけ、env ごとに解決済みの設定を返す。
 *
 * **Worker も env も列挙をハードコードしない。** 片方でも手で書くと、
 * 増えたときに黙って検査の対象から漏れる（#270 で `AUDIT_EVENTS` が
 * 同じ漏れ方をした）。`check-service-bindings.mjs` が Worker を走査して
 * いるのと同じ理由。
 *
 * `check-route-patterns.mjs` と `check-webauthn-origin.mjs` が使う。
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const appsDir = path.join(repoRoot, "apps");

/** @returns {{ app: string, config: string }[]} */
export function findWorkerConfigs() {
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ app: e.name, config: path.join(appsDir, e.name, "wrangler.jsonc") }))
    .filter((e) => existsSync(e.config));
}

/** その app の node_modules にある wrangler を読む。 */
async function loadWrangler(appDir) {
  const require = createRequire(pathToFileURL(path.join(appDir, "_")).href);
  return import(pathToFileURL(require.resolve("wrangler")).href);
}

/**
 * 設定ファイルに書かれている env の名前を拾う。
 *
 * **`unstable_readConfig` は env 解決済みの形しか返さない**（`config.env`
 * は空）。どの env があるかは生のファイルからしか分からない。
 */
export function envNamesOf(configPath) {
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
    // ここで落とさずに済む。呼び出し側が「0 件」を故障として扱う。
    return [];
  }
}

/**
 * 全 Worker × 全 env（既定を含む）の解決済み設定を順に返す。
 *
 * @returns {AsyncGenerator<{ app: string, env: string, config: any }>}
 */
export async function* eachWorkerEnv() {
  for (const { app, config } of findWorkerConfigs()) {
    const { unstable_readConfig } = await loadWrangler(path.join(appsDir, app));
    for (const env of [undefined, ...envNamesOf(config)]) {
      const resolved = unstable_readConfig(env === undefined ? { config } : { config, env });
      yield { app, env: env ?? "(default)", config: resolved };
    }
  }
}
