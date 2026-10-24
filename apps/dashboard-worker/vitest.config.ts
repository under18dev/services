import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * dashboard-worker のテスト設定。
 *
 * wrangler.jsonc の `services` が auth-worker (`u18-auth`) を参照しているため、
 * そのままだと workerd が
 *   binding "IDENTITY" refers to a service "core:user:u18-auth",
 *   but no such service is defined
 * で**起動に失敗し、テストが 1 件も走らない**。dashboard-worker に長らく
 * テストが無かったのはこれが理由（#47）。
 *
 * ここでは `u18-auth` という名前のスタブ Worker を補助 Worker として定義し、
 * バインディングの解決だけを通す。テスト本体はこのスタブを呼ばない ——
 * `IdentityGateway` の fake を差した `Env` を `app.fetch()` へ直接渡して、
 * HTTP 層の責務（Cookie 名・Origin 検証・エラー翻訳）だけを検証する。
 *
 * 本物の auth-worker を立てて RPC 越しに繋ぐのは、この Worker 単体の
 * テストではなく統合テスト (`tests/e2e/`) の仕事。
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        workers: [
          {
            // 名前は既定 env の binding (`u18-auth`) に合わせてある。
            // `env.production` は `u18-auth-production` を指すので、production
            // 設定でこのテストを走らせると同じ起動エラーになる。その場合は
            // ここにもう 1 つスタブを足すこと。
            name: "u18-auth",
            modules: true,
            script:
              // 599 と明示的な本文にしてあるのは、テストが誤って fake ではなく
              // 本物の binding を叩いたときに気づけるようにするため。501 だと
              // 「未実装エンドポイント」と読めてしまい、配線ミスに見えない。
              "export default { fetch: () => new Response(" +
              "'stub worker - you meant to inject a fake IdentityRpcContract into app.fetch()'," +
              " { status: 599 }) };" +
              // RPC entrypoint 名も wrangler.jsonc に書かれているので形だけ用意する。
              "export class IdentityRPC {}",
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
