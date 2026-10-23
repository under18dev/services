import { env } from "cloudflare:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../../packages/db/drizzle");

/**
 * テスト用 D1 にマイグレーションを適用する。
 *
 * wrangler の `applyD1Migrations` は wrangler.jsonc の migrations_dir を
 * 見に行くが、ここでは生成済み SQL を直接流して「生成物とテストが
 * 同じスキーマを見ている」ことを保証する。
 */
export async function applyMigrations(): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // drizzle-kit は文を `--> statement-breakpoint` で区切る。
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const statement of statements) {
      await env.IDENTITY_DB.exec(statement.replaceAll("\n", " "));
    }
  }
}

/** テーブルを空にする。テスト間で状態が漏れないようにする。 */
export async function resetDatabase(): Promise<void> {
  const tables = await env.IDENTITY_DB.prepare(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '_cf_%' and name not like 'd1_%'",
  ).all<{ name: string }>();

  for (const { name } of tables.results) {
    await env.IDENTITY_DB.exec(`delete from "${name}"`);
  }
}
