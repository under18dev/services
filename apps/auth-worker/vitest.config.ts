import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Workers ランタイム上でテストを走らせる（仕様書 11.2）。
 *
 * マイグレーションの読み込みは **Node 側（この設定ファイル）** で行う。
 * テスト本体は workerd の中で動くので node:fs を使えない。読み込んだ SQL は
 * バインディング経由でテストへ渡し、setup で適用する。
 */
const migrations = await readD1Migrations(join(import.meta.dirname, "../../packages/db/drizzle"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["IDENTITY_DB"],
        bindings: {
          TEST_MIGRATIONS: migrations,
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
