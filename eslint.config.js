// @ts-check
import tseslint from "typescript-eslint";
import boundaries from "./packages/config/eslint.layers.js";
import noInlineStyle from "./packages/config/eslint.no-inline-style.js";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      ".claude/worktrees/**",
      "**/dist/**",
      "**/.wrangler/**",
      "**/worker-configuration.d.ts",
      "packages/db/drizzle/**",
      // クライアントアイランドのバンドル（生成物）。`.gitignore` と同じ
      // 4 本——auth-worker だけを先に書いていて、他 3 Worker が漏れていた
      // （#470 で `admin-worker/preview-html/` に生成物の JS を書き出す
      // ようになり、ESLint がそれを拾って気づいた。それまでは `generated/`
      // がビルド前に存在せず、`preview-html/` も HTML/CSS しか無かったので
      // 拾われていなかった）。
      "apps/auth-worker/src/presentation/http/ui/generated/**",
      "apps/dashboard-worker/src/presentation/http/ui/generated/**",
      "apps/nfc-worker/src/presentation/http/ui/generated/**",
      "apps/admin-worker/src/presentation/http/ui/generated/**",
      "apps/admin-worker/preview-html/**",
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
  // JSX の style 属性を書いた時点で落とす (#326、#320 の後追い)
  ...noInlineStyle,
);
