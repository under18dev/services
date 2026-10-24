// Layered Architecture の依存方向を ESLint で強制する。
//   Presentation -> Application -> Domain
//   Infrastructure -> Application(Ports) / Domain
// Domain は Hono / Drizzle / Cloudflare の Env に依存してはならない。
// 仕様書 2.3 および MVP 受け入れ基準「Domain/Application が Cloudflare・Hono・Drizzle に
// 直接依存しない」に対応する。

const FRAMEWORKS = ["hono", "hono/*", "drizzle-orm", "drizzle-orm/*", "cloudflare:*", "@u18/db"];

/** @type {import("typescript-eslint").ConfigArray} */
export default [
  {
    files: ["apps/*/src/domain/**/*.{ts,tsx}", "packages/domain/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...FRAMEWORKS,
            "**/application/**",
            "**/infrastructure/**",
            "**/presentation/**",
            "**/composition/**",
          ],
          paths: [],
        },
      ],
    },
  },
  {
    files: ["apps/*/src/application/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...FRAMEWORKS,
            "**/infrastructure/**",
            "**/presentation/**",
            "**/composition/**",
          ],
        },
      ],
    },
  },
  {
    files: ["apps/*/src/presentation/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // **Infrastructure 全体**を禁じる（persistence だけではない）。
          //
          // 以前は `**/infrastructure/persistence/**` だけを禁じていたが、
          // それだと dashboard-worker の `RpcIdentityGateway`（`infrastructure/rpc/`）
          // のように**永続化以外の Infrastructure を Presentation が直接 new する**
          // 形が通ってしまう。冒頭に書いてある依存方向（Presentation -> Application）
          // を規則が表現できていなかった（#119）。
          //
          // 組み立ては `composition/` の仕事で、Presentation が見てよいのは
          // Port の型だけ。3 つの Worker すべてがこの形になっている。
          // `hono` と `cloudflare:*` は禁じない。Presentation はフレームワークを
          // 使う層であり、RPC の entrypoint は `cloudflare:workers` の
          // `WorkerEntrypoint` を継承する必要がある。
          patterns: ["drizzle-orm", "drizzle-orm/*", "@u18/db", "**/infrastructure/**"],
        },
      ],
    },
  },
];
