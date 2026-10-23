import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Workers ランタイム上でテストを走らせる（仕様書 11.2）。
 *
 * `d1Databases` を指定すると miniflare がローカル D1 を用意し、
 * 本番と同じ SQLite の挙動で Repository を検証できる。
 */
export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          d1Databases: ["IDENTITY_DB"],
          bindings: {
            ENVIRONMENT: "development",
            ISSUER: "http://localhost:8787",
            IP_HASH_PEPPER: "test-pepper",
          },
        },
      },
    },
  },
});
