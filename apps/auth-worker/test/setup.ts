import { applyD1Migrations, env } from "cloudflare:test";

/**
 * テスト用 D1 に、生成済みマイグレーションをそのまま適用する。
 *
 * テストが本番と同じスキーマを見ていることを保証するため、スキーマを
 * 手書きせず packages/db/drizzle の生成物を適用する。
 */
await applyD1Migrations(env.IDENTITY_DB, env.TEST_MIGRATIONS);
