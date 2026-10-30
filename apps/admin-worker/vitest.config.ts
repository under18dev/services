import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * admin-worker のテスト設定。
 *
 * **Service Binding のスタブが要らない。** `wrangler.jsonc` に `services`
 * を持たない——u18 Identity 側には何も足さない設計（運用者の判断、
 * 2026-10-30 夜）のため、RPC で繋ぐ Worker が存在しない。
 *
 * **D1 は持つ。** 承認リスト（`ADMIN_DB`）のマイグレーションを
 * `packages/admin-db/drizzle` から読み、`test/setup.ts` で適用する
 * （`apps/nfc-worker/vitest.config.ts` と同じ形）。
 *
 * **CSRF の走査も無い。** この Worker の書き込み経路は OIDC の
 * Authorization Code Flow で、すべて GET（認可コードはリダイレクトの
 * クエリで届く）。form POST が 1 本も無いので、dashboard-worker の
 * `collectFormCsrfSites` に相当するものは**まだ**要らない——最初の
 * form が入ったら、あちらと同じ形で足すこと（#253）。
 *
 * **Secret はテスト用の固定値を直接入れる。** `wrangler.jsonc` は
 * Secret を宣言しない（`wrangler secret put` で渡すため）ので、
 * auth-worker の `IP_HASH_PEPPER` と同じ形で注入する。
 */
const migrations = await readD1Migrations(
  join(import.meta.dirname, "../../packages/admin-db/drizzle"),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["ADMIN_DB"],
        bindings: {
          TEST_MIGRATIONS: migrations,
          SESSION_SECRET: "test-session-secret-at-least-32-bytes!!",
          OIDC_CLIENT_SECRET: "test-client-secret",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
  },
});
