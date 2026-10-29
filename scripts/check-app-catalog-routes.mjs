// @ts-check
/**
 * アプリカタログ（`ui/app-catalog.ts`）の `/` 始まりの行き先が、
 * **どれかの Worker の production route に覆われている**ことを検査する。
 *
 * 理由と突き合わせ方は `lib/app-catalog-routes.mjs` の冒頭に書いてある。
 * 要点だけ: カタログの `/account/nfc` は **nfc-worker** が答える手書きの
 * 一致で、どちらのリポジトリ内テストもこの組を見ていない（#211 の家系）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { eachWorkerEnv, findWorkerConfigs } from "./lib/wrangler-configs.mjs";
import {
  readCatalogUrls,
  readInventoryPaths,
  readStringConstants,
  unreachablePaths,
} from "./lib/app-catalog-routes.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const UI = path.join(ROOT, "apps", "dashboard-worker", "src", "presentation", "http", "ui");
const CATALOG = path.join(UI, "app-catalog.ts");
const ASSET_PATHS = path.join(UI, "asset-paths.ts");

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

let catalogText;
let assetPathsText;
try {
  catalogText = readFileSync(CATALOG, "utf8");
  assetPathsText = readFileSync(ASSET_PATHS, "utf8");
} catch (error) {
  fail(
    `could not read the app catalog (${error instanceof Error ? error.message : String(error)}). ` +
      `This is a bug in the check, not a clean repository.`,
  );
}

const raw = readCatalogUrls(catalogText);
if (raw === null) {
  // **「読めなかったので 0 件」を「問題なし」にしない。** カタログの
  // 書き方が変わって拾えなくなっても検査は緑のまま、本番だけが 404 を出す。
  fail(
    `APP_CATALOG could not be parsed out of ${path.relative(ROOT, CATALOG)}. ` +
      `The check reads the TypeScript as text, so a change to how entries are written ` +
      `silently empties it. Update lib/app-catalog-routes.mjs along with the catalog.`,
  );
}

// 定数参照（`url: NFC_CARDS_PATH`）を `asset-paths.ts` の値に解決する。
const constants = readStringConstants(assetPathsText);
const paths = [];
for (const url of raw) {
  if (!url.startsWith("@")) {
    // 外部リンクはこちらの wrangler.jsonc に出てこない。対象外。
    if (url.startsWith("/")) paths.push(url);
    continue;
  }
  const name = url.slice(1);
  const value = constants[name];
  if (value === undefined) {
    fail(
      `APP_CATALOG refers to ${name}, but no "export const ${name} = \\"...\\";" was found in ` +
        `${path.relative(ROOT, ASSET_PATHS)}. If it is now built from a template literal, it ` +
        `belongs to this Worker and does not need this check — inline the literal or drop it here.`,
    );
  }
  if (value.startsWith("/")) paths.push(value);
}

if (findWorkerConfigs().length === 0) {
  fail(
    "No apps/*/wrangler.jsonc found, so no route was checked. " +
      "This is a bug in the check, not a clean repository.",
  );
}

/** production env の route を、どの Worker のものかと一緒に集める。 */
const routes = [];
for await (const { app, env, config } of eachWorkerEnv()) {
  if (env !== "production") continue;
  for (const route of config?.routes ?? []) {
    const pattern = typeof route === "string" ? route : route?.pattern;
    if (typeof pattern === "string") routes.push({ worker: app, pattern });
  }
}

if (routes.length === 0) {
  // `check-route-patterns.mjs` と同じ理由。本番 route は実在するので、
  // 0 件は検査の故障である。
  fail(
    "No production route patterns were found in any apps/*/wrangler.jsonc, so nothing was " +
      "checked. This is a bug in the check, not a clean repository.",
  );
}

/** 勝った Worker の `route-inventory.ts` を読む。読めなければ `null`。 */
const inventoryCache = new Map();
function inventoryOf(worker) {
  if (!inventoryCache.has(worker)) {
    const file = path.join(ROOT, "apps", worker, "test", "route-inventory.ts");
    try {
      const found = readInventoryPaths(readFileSync(file, "utf8"));
      // **0 件は「読めた」と見なさない。** 一覧の書き方が変わって拾えなく
      // なった状態を「登録が無い」と報告すると、原因を取り違える。
      inventoryCache.set(worker, found.length === 0 ? null : found);
    } catch {
      inventoryCache.set(worker, null);
    }
  }
  return inventoryCache.get(worker);
}

const problems = unreachablePaths(paths, routes, inventoryOf);
if (problems.length > 0) {
  for (const { path: p, reason } of problems) {
    console.error(
      `::error::app catalog lists "${p}", but ${reason}. ` +
        `A catalog entry that 404s is exactly the dead link #306 was about. ` +
        `Either fix the url in app-catalog.ts, or fix the Worker that should serve it.`,
    );
  }
  process.exit(1);
}

// **0 件は「問題なし」と書き分ける。** カタログが空になるのは設計上
// ありうるので落とさないが、「何も調べていない」ことは出力に出す。
console.log(
  paths.length === 0
    ? `app catalog: no same-origin entries to check (${routes.length} production routes read)`
    : `app catalog: ${paths.length} same-origin entr${paths.length === 1 ? "y reaches" : "ies reach"} the Worker that registers it`,
);
