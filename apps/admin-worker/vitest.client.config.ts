import { defineConfig } from "vitest/config";

/**
 * アイランド（`ui/client/**`）だけの、ブラウザに近い環境でのテスト（#470）。
 *
 * **`vitest.config.ts` とは別枠にしてある。** あちらは `@cloudflare/
 * vitest-plugin` で workerd の中で動かすので `document` が無い
 * （`scripts/preview-html.generator.mts` が plain Node を別枠にしている
 * のと同じ理由で、今度は逆向きに「DOM が要るものを分ける」）。
 *
 * `happy-dom` を選んだのは `jsdom` より軽く、ここで要る範囲
 * （`querySelector` / `classList` / イベント）で足りるため。
 */
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/presentation/http/ui/client/**/*.test.ts"],
  },
});
