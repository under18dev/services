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
 * レート制限の窓の**境界を跨がない**位置から始める（#176）。
 *
 * ## なぜ要るのか
 *
 * Cloudflare の Rate Limiting は**壁時計に揃った固定窓**で、
 * `epoch = floor(now / period)` で数える。全キーが**同じ瞬間に一斉に
 * リセットされる**。
 *
 * 「上限まで送ってから 1 本余計に送る」形のテストは、その途中で窓が
 * 切り替わるとカウンタが 0 に戻り、**最後の 1 本が通ってしまう。**
 * 実装は正しいのにテストだけが落ちる。
 *
 * ## なぜ共有の場所に置いてあるか
 *
 * **ランブック §13.2 は「別のファイルで同じ形を書くときは同じ手当てが
 * 要る」と書いているが、手当てそのものは `rate-limit.test.ts` の中に
 * 閉じていた。** 書いてある指示に従おうとしても、**コピーするしか
 * なかった**。実際 `rate-limit-form.test.ts`（#232）は手当て無しで
 * 入り、CI で `expected 200 to be 429` として出た。
 *
 * 指示を守れる形にしないと、指示は守られない。
 *
 * > **文書に「気をつけて」と書く形は守られない。`import` すれば効く場所に
 * > 置けば、次に書く人は何も覚えていなくてよい。**（#253）
 *
 * ## `marginMs` を呼び出し側が決める
 *
 * 必要な余裕は**そのファイルの 1 件がどれだけ時間を食うか**で決まる。
 *
 * | 呼び出し側                | 1 件の実測              |
 * | ------------------------- | ----------------------- |
 * | `rate-limit.test.ts`      | バースト 20 本で 21ms   |
 * | `rate-limit-form.test.ts` | 1 件 78ms（CI で 398ms）|
 *
 * **CI は手元より 5 倍遅い。** 既定の 1 秒は前者には十分だが、後者には
 * 足りない —— 398ms は 1 秒の 4 割で、もう少し遅い日に跨ぐ。
 * 既定を全体に合わせて広げると、速いファイルが毎回無駄に待つので、
 * **使う側が自分の実測から決める。**
 */
export async function startOfRateLimitWindow(
  periodSeconds: number,
  marginMs = 1_000,
): Promise<void> {
  const period = periodSeconds * 1_000;
  const remaining = period - (Date.now() % period);
  if (remaining >= marginMs) return;
  await new Promise((resolve) => setTimeout(resolve, remaining + 50));
}
