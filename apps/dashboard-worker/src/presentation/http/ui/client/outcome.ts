/**
 * 取り消しの応答を「消えた / 消えていない」に畳む。
 *
 * ## 404 を成功として扱う
 *
 * 「もう無いものを消そうとした」だけで、**利用者から見た結果は同じ**
 * （その項目はもう効いていない）。失敗として見せると「消えていないのでは」
 * と思わせ、もう一度押させることになる。
 *
 * 起きるのは、別のタブで先に消した / 期限切れでセッションが消えた、など。
 * どれも**取り消したかった状態には既になっている。**
 *
 * services-6f の指摘（#210）。
 *
 * ## なぜアイランドの中に書かないのか
 *
 * **アイランドは DOM を使うので Worker 上の vitest から動かせない。**
 * 判断だけをここへ出せば、バンドルされた文字列を正規表現で睨むのではなく
 * **関数として直接確かめられる**（`test/island-outcome.test.ts`）。
 * `client/api-client.ts` を出したのと同じ理由である。
 */
export function isRemoved(response: { readonly ok: boolean; readonly status: number }): boolean {
  return response.ok || response.status === 404;
}
