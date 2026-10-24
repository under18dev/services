import { applyD1Migrations, env } from "cloudflare:test";

/**
 * テスト用 D1 に、生成済みマイグレーションをそのまま適用する。
 *
 * スキーマを手書きせず `packages/nfc-db/drizzle` の生成物を流すのは、
 * テストと本番が同じスキーマを見ていることを保証するため。
 * `pnpm --filter @u18/nfc-db generate` を忘れたままスキーマを変えると、
 * ここでずれが表面化する。
 */
await applyD1Migrations(env.NFC_DB, env.TEST_MIGRATIONS);
