import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * nfc-worker のテスト設定。
 *
 * auth-worker と dashboard-worker の両方の事情を抱えている。
 *
 * 1. **D1 を持つ**（auth-worker 側の事情）
 *    テスト本体は workerd の中で動くので `node:fs` が使えない。
 *    マイグレーションの読み込みは Node 側であるこのファイルで行い、
 *    binding 経由でテストへ渡して `test/setup.ts` で適用する。
 *    読むのは `packages/nfc-db/drizzle` —— Identity 側の
 *    `packages/db/drizzle` ではない。混ぜると、分離した意味が
 *    テスト環境だけ無くなる。
 *
 * 2. **Service Binding を持つ**（dashboard-worker 側の事情）
 *    `wrangler.jsonc` の `services` が `u18-auth` を参照しているため、
 *    そのままだと workerd が
 *      binding "IDENTITY" refers to a service "core:user:u18-auth",
 *      but no such service is defined
 *    で**起動に失敗し、テストが 1 件も走らない**。
 *    名前だけのスタブ Worker を置いて解決を通す。
 *
 * テスト本体はこのスタブを呼ばない。`IdentityGateway` の fake を
 * `createApp({ identity })` に差して、認可の分岐を検証する。
 * 本物の auth-worker と RPC で繋ぐのは統合テスト (`tests/e2e/`) の仕事。
 */
const migrations = await readD1Migrations(
  join(import.meta.dirname, "../../packages/nfc-db/drizzle"),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["NFC_DB"],
        workers: [
          {
            // 名前は既定 env の binding (`u18-auth`) に合わせてある。
            // `env.production` は `u18-auth-production` を指すので、
            // production 設定でこのテストを走らせるなら、もう 1 つ要る。
            name: "u18-auth",
            modules: true,
            script:
              // 599 と明示的な本文にしてあるのは、テストが誤って fake では
              // なく本物の binding を叩いたときに気づけるようにするため。
              "export default { fetch: () => new Response(" +
              "'stub worker - you meant to inject a fake IdentityGateway into createApp()'," +
              " { status: 599 }) };" +
              "export class IdentityRPC {}",
          },
        ],
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Cookie 名の分岐（`__Host-` の有無）を development 側で固定する。
          ENVIRONMENT: "development",
          // 遷移先の禁止オリジンだけは**本番の値**を入れてある。
          // 既定 env の値は http://localhost:... で、そもそも `https:` で
          // ない時点で弾かれるため、「禁止オリジンだから弾かれた」のか
          // 「http だから弾かれた」のか区別できない。本番で効かせたい
          // 規則（IdP 自身・短縮 URL 自身への遷移の禁止）を検証するために、
          // ここだけ production 相当にしている。
          AUTH_ISSUER: "https://auth.under18.dev",
          SHORT_URL_ORIGIN: "https://go.under18.dev",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
