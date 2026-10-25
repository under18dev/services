/**
 * ログイン後の戻り先を Worker 間で受け渡すための取り決め。
 *
 * ## なぜ contracts に置くのか
 *
 * ログイン画面を持つのは **auth-worker** だが、未ログインで弾かれて
 * そこへ送るのは **dashboard-worker**（`/account/*`）と **nfc-worker**
 * （`/account/nfc`）である。パラメータ名を各 Worker に書くと、
 * **片方を直してもう片方を忘れた瞬間に「ログインはできるが元の画面へ
 * 戻らない」**という、誰も落ちないまま壊れる形になる。
 *
 * ## 検証はここに置かない
 *
 * 値が戻り先として使ってよいかの判断（オープンリダイレクト対策）は
 * **auth-worker の `ui/return-to.ts` だけ**が持つ。関門を増やすと
 * 「どちらかが通したから大丈夫」という曖昧さが生まれる。ここにあるのは
 * **名前と組み立て方**だけで、何を許すかは知らない。
 */

/** 戻り先を載せるクエリ名。form の hidden input 名もこれに揃える。 */
export const RETURN_TO_PARAM = "return_to";

/**
 * 戻り先つきのログイン画面 URL を作る。
 *
 * **渡す値は呼び出し元の責任で決める。** ここでは符号化しかしない。
 * 受け取った auth-worker 側が `sanitizeReturnTo` で必ず検証するので、
 * 不正な値を渡しても戻り先として使われることはない（捨てられる）。
 */
export function loginUrlWithReturnTo(returnTo: string | null): string {
  if (returnTo === null || returnTo === "") return "/login";
  return `/login?${RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`;
}

/**
 * いま処理しているリクエストの URL から、戻り先として渡す値を作る。
 *
 * ホスト部を落としてパスとクエリだけにする。**絶対 URL のまま渡すと、
 * 受け取り側の検証が「相対パスだけ」を前提にしている分だけ必ず捨てられる。**
 */
export function returnToForCurrentRequest(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}
