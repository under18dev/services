import { defineConfig } from "drizzle-kit";

/**
 * マイグレーション生成専用の設定。
 *
 * 生成した SQL は wrangler (`wrangler d1 migrations apply`) で適用するため、
 * ここに D1 の認証情報は持たせない。本番 DB への接続はデプロイ経路に閉じる。
 */
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
