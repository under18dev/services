import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * admin-worker のテスト設定。
 *
 * **Service Binding のスタブが要る**（#382 / #390 決定 16 ③）。
 * `wrangler.jsonc` に `NFC_ADMIN_DELEGATED`（nfc-worker の
 * `NfcAdminDelegatedRPC`）を持つ——**u18 Identity への binding は
 * 依然として持たない**（運用者の判断、2026-10-30 夜）が、nfc-worker
 * とは繋がる。テストでは本物の nfc-worker を立てず、
 * `ContainerOverrides.nfcCards` に fake を差す（`test/nfc.routes.test.ts`）
 * ——それでも `wrangler.jsonc` が宣言した Entrypoint 名が無いと workerd が
 * 起動に失敗する（#47 と同じ形）ので、スタブだけは要る。
 *
 * **D1 は持つ。** 承認リスト（`ADMIN_DB`）のマイグレーションを
 * `packages/admin-db/drizzle` から読み、`test/setup.ts` で適用する
 * （`apps/nfc-worker/vitest.config.ts` と同じ形）。
 *
 * **CSRF の走査はまだ無い。** NFC 管理画面（#382）が最初の form POST を
 * 持ち込んだが、`collectFormCsrfSites` の移植はまだしていない——
 * `test/nfc.routes.test.ts` がこの画面の CSRF を直接見ている。
 * **2 本目の form を足す人へ: 先にあの走査を移植すること**
 * （dashboard-worker / nfc-worker の同名ファイルに同じ注意がある。#253）。
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
        workers: [
          {
            // 名前は既定 env の binding（`u18-nfc`）に合わせてある。
            // `env.production` は `u18-nfc-production` を指すので、
            // production 設定でこのテストを走らせると同じ起動エラーに
            // なる。その場合はここにもう 1 つスタブを足すこと
            // （dashboard-worker の同名ファイルと同じ注意）。
            name: "u18-nfc",
            modules: true,
            script:
              // 599 にしているのは、テストが誤って fake ではなく本物の
              // binding を叩いたときに気づけるようにするため
              // （dashboard-worker の `u18-auth` スタブと同じ理由）。
              "export default { fetch: () => new Response(" +
              "'stub worker - you meant to inject a fake NfcAdminDelegatedRpcContract into createApp()'," +
              " { status: 599 }) };" +
              "export class NfcAdminDelegatedRPC {}",
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
  },
});
