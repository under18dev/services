/**
 * 本筋でない副作用をまとめて実行する。
 *
 * 監査ログの記録や最終アクセス時刻の更新は、認証そのものの成否とは別物。
 * 1 つ失敗したからといって認証を落とすと、可観測性の問題がそのまま
 * 認証停止になる（仕様書のレビューで出た論点）。
 *
 * `Promise.allSettled` を使うのはそのため。`Promise.all` だと最初の
 * 失敗で即 reject し、残りの副作用が中断されるうえ呼び出し元へ例外が飛ぶ。
 * ここでは全部を走らせ切り、失敗はログにだけ残す。
 */
export async function settleSideEffects(
  label: string,
  ...tasks: readonly Promise<unknown>[]
): Promise<void> {
  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(`side effect failed: ${label}`, result.reason);
    }
  }
}
