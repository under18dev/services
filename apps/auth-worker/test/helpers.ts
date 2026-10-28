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

/**
 * レート制限の窓の**頭**まで待つ。
 *
 * ## なぜ要るのか
 *
 * Cloudflare（ここでは miniflare）の Rate Limiting は**壁時計に揃った
 * 固定窓**で、`epoch = floor(now / period)` で数える。全キーが同じ瞬間に
 * 一斉にリセットされる。
 *
 * 「上限まで送ってから 1 本余計に送る」形のテストは、その途中で窓が
 * 切り替わるとカウンタが 0 に戻り、**最後の 1 本が通ってしまう。**
 * 実装は正しいのにテストだけが落ちる（#176）。
 *
 * ## なぜ helpers に置くのか
 *
 * **ランブック §13.2 に「別のファイルで同じ形を書くときは同じ手当てが
 * 要る」と書いてあったが、守られなかった。** `rate-limit-form.test.ts`
 * （#232）がガード無しで入り、#252 の CI を落とした ——
 * **#252 とは無関係な落ち方**で、原因を追う時間がそのまま失われる。
 *
 * 文書に「気をつけて」と書く形は守られない。**import すれば効く**場所に
 * 置けば、次に書く人は何も覚えていなくてよい。
 *
 * 実測でバースト 20 本が 21ms（1 本あたり約 1ms）なので、60 本でも
 * 70ms 程度。1 秒の余裕は 10 倍以上ある。
 */
export async function startOfRateLimitWindow(periodSeconds: number): Promise<void> {
  const margin = 1_000;
  const period = periodSeconds * 1_000;
  const remaining = period - (Date.now() % period);
  if (remaining >= margin) return;
  await new Promise((resolve) => setTimeout(resolve, remaining + 50));
}
