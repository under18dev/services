import { env } from "cloudflare:test";
import { expect } from "vitest";

/**
 * テーブルを空にする。
 *
 * マイグレーションは setup.ts で一度だけ適用済みなので、ここでは行だけを消す。
 * d1_migrations / 内部テーブルは残す。
 */
export async function resetDatabase(): Promise<void> {
  const tables = await env.IDENTITY_DB.prepare(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '_cf_%' and name not like 'd1_%'",
  ).all<{ name: string }>();

  // テーブル間に依存は無いので同時に消す。FK は ON DELETE CASCADE なので
  // 順序に意味が無く、直列にしても得られるものが無い。
  await Promise.all(
    tables.results.map(({ name }) => env.IDENTITY_DB.exec(`delete from "${name}"`)),
  );
}

/**
 * 一意制約違反で落ちたことを確かめる。
 *
 * Drizzle は元の例外を「Failed query: ...」で包むので、SQLite の
 * メッセージは `cause` 側にしか出てこない。単に throw したことだけを
 * 見ると、別の理由（FK 違反など）で落ちていても通ってしまう。
 */
export async function expectUniqueViolation(run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "クエリが成功してしまった").toBeDefined();

  const messages: string[] = [];
  let current: unknown = thrown;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  expect(messages.join(" / ")).toMatch(/UNIQUE constraint failed/i);
}
