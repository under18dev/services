/**
 * 取り消しの応答を「消えた」と見てよいか。
 *
 * ## なぜ 404 も「消えた」なのか
 *
 * 「**既に無いものを消そうとした**」だけで、利用者から見た結果
 * （もう使えない）は同じである。失敗として見せると「消えていないのでは」
 * と思わせる —— **利用者には確かめる手段が無く、不安だけが残る。**
 *
 * 別のタブで同じものを取り消した、セッションが期限切れで掃除された
 * （`retention.sweep`）、といった経路で普通に起きる。
 *
 * ## なぜ別ファイルなのか
 *
 * `account-island.ts` はモジュールの先頭で `document` を触るので、
 * vitest（workerd 上）から import できない。**判定だけを切り出せば
 * 本物を呼ぶテストが書ける**（`client/api-client.ts` と同じ理由）。
 *
 * ここでテストの中に `status === 404` と書き直すと、検査しているのは
 * 「テストの中の判定」になり、アイランドが間違っていても通る。
 */
export function isRevoked(response: { readonly ok: boolean; readonly status: number }): boolean {
  return response.ok || response.status === 404;
}
