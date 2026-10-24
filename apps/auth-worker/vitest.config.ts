import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Workers ランタイム上でテストを走らせる（仕様書 11.2）。
 *
 * マイグレーションの読み込みは **Node 側（この設定ファイル）** で行う。
 * テスト本体は workerd の中で動くので node:fs を使えない。読み込んだ SQL は
 * バインディング経由でテストへ渡し、setup で適用する。
 *
 * `wrangler.jsonc` も同じ理由でここから渡す。`rate-limit-config.test.ts` が
 * `ratelimits` の設定と `RateLimitPolicy` を照合するのに使う（#21）。
 * **文字列のまま渡す** —— JSONC（コメントと末尾カンマ）なので JSON.parse は
 * 通らず、テスト側の `test/jsonc.ts` で読む。
 */
const migrations = await readD1Migrations(join(import.meta.dirname, "../../packages/db/drizzle"));
const wranglerSource = readFileSync(join(import.meta.dirname, "wrangler.jsonc"), "utf8");

/**
 * `src/` に書かれている監査イベント名をすべて集める（#22）。
 *
 * `AUDIT_EVENTS`（登録簿）と実装が離れていないかを
 * `test/audit-events.test.ts` が照合するのに使う。登録簿に足しただけで
 * どこからも発行されない名前や、逆に発行されているのに登録簿に無い名前を
 * 見つけるのが目的。
 *
 * **行コメントの中は数えない。** `// 監査ログ（event: "retention.sweep"）に
 * 出している` のような説明が `src/index.ts` にあり、それを実装と
 * 取り違えると照合が緩む。
 *
 * ソースの走査は Node 側でしかできない（テスト本体は workerd の中で動く）。
 */
function collectAuditEventNames(dir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      names.push(...collectAuditEventNames(path));
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const code = line.split("//")[0] ?? "";
      for (const match of code.matchAll(/event: "([a-z_.]+)"/g)) names.push(match[1]!);
    }
  }
  return names;
}

const auditEventNames = [
  ...new Set(collectAuditEventNames(join(import.meta.dirname, "src"))),
].sort();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["IDENTITY_DB"],
        bindings: {
          TEST_MIGRATIONS: migrations,
          TEST_WRANGLER_JSONC: wranglerSource,
          TEST_AUDIT_EVENT_NAMES: auditEventNames,
          ENVIRONMENT: "development",
          ISSUER: "http://localhost:8787",
          IP_HASH_PEPPER: "test-pepper",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
