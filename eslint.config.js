// @ts-check
import tseslint from "typescript-eslint";
import boundaries from "./packages/config/eslint.layers.js";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      ".claude/worktrees/**",
      "**/dist/**",
      "**/.wrangler/**",
      "**/worker-configuration.d.ts",
      "packages/db/drizzle/**",
      // クライアントアイランドのバンドル（生成物）。
      "apps/auth-worker/src/presentation/http/ui/generated/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": "off",
    },
  },
  // Layered Architecture の依存方向を lint で強制する (仕様書 2.3)
  ...boundaries,
);
