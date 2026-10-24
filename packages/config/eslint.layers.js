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
    files: ["apps/*/src/domain/**/*.ts", "packages/domain/src/**/*.ts"],
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
    files: ["apps/*/src/application/**/*.ts"],
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
    files: ["apps/*/src/presentation/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ["drizzle-orm", "drizzle-orm/*", "**/infrastructure/persistence/**"],
        },
      ],
    },
  },
];
