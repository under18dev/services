import { defineConfig } from "drizzle-kit";

/**
 * admin-worker 専用 D1 のマイグレーション生成設定。
 *
 * **u18 Identity の D1 とは別にする。** 運用者の判断（2026-10-30 夜）で
 * 「u18 Identity 側には何も足さない」——誰を承認するかという admin-worker
 * 固有の記憶を、Identity の D1 に同居させると、その判断と逆向きになる。
 * `packages/nfc-db` が同じ理由で Identity と分かれているのと同じ形。
 */
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
