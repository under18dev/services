import { applyD1Migrations, env } from "cloudflare:test";

/**
 * テスト用 D1 に、生成済みマイグレーションをそのまま適用する。
 *
 * スキーマを手書きせず `packages/admin-db/drizzle` の生成物を流すのは、
 * テストと本番が同じスキーマを見ていることを保証するため
 * （`apps/nfc-worker/test/setup.ts` と同じ理由）。
 */
await applyD1Migrations(env.ADMIN_DB, env.TEST_MIGRATIONS);
