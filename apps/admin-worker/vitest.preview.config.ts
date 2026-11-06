import { defineConfig } from "vitest/config";

/**
 * プレビュー生成（`scripts/preview-html.generator.mts`）の不変条件だけの
 * 別枠（#524）。
 *
 * **`vitest.config.ts`（workerd）でも `vitest.client.config.ts`（happy-dom）
 * でもない、plain Node。** `buildPreviewPages()` は `createApp()` を
 * plain Node で呼ぶだけ（`preview-html.generator.mts` 冒頭の JSDoc を
 * 参照——D1 / Service Binding には触れない設計）なので、workerd の中で
 * 動かす理由が無い。既定の `environment: "node"` のままでよい。
 */
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.mts"],
  },
});
