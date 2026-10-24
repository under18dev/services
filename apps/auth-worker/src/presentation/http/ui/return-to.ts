/**
 * ログイン後の戻り先の持ち回し（#15）。
 *
 * ## これがオープンリダイレクトの温床になる
 *
 * `/oauth/authorize` に未ログインで来た利用者は `/login` へ送られ、
 * ログインが済んだら元の認可要求へ戻る必要がある。この「戻り先」を
 * そのまま `Location` に載せる実装が、認証基盤におけるオープンリダイレクトの
 * 典型的な作られ方である。`https://evil.test` を `return_to` に入れた
 * ログイン画面のリンクを配れば、u18 のドメインから始まるフィッシング導線が
 * できあがる。
 *
 * ## 採った方針: 許可リストで、1 つのパスだけ
 *
 * 「同一オリジンなら許す」でも「相対パスなら許す」でもなく、
 * **`/oauth/authorize` で始まる相対パスだけ**を通す。
 *
 * - 戻り先が要る経路は認可フローしか無い。将来増えたらそのときに足せばよく、
 *   先回りして広げる理由が無い。
 * - 「相対パスなら安全」は成り立たない。`//evil.test/` と `/\evil.test` は
 *   ブラウザによって別オリジンの絶対 URL として解釈される。
 *   先頭 2 文字を見るだけの実装はここで落ちる。
 * - 判定を `new URL()` の解釈に委ねない。基準 URL の与え方次第で
 *   結果が変わるので、生の文字列に対する前方一致で決める。
 *
 * 不正な値は**エラーにせず捨てる**。利用者から見れば「ログイン後に
 * トップへ戻った」だけで、やり直せる。
 */

/** 戻り先として受け付けるパス。認可フロー以外に戻り先の要る経路は無い。 */
const ALLOWED_PREFIX = "/oauth/authorize";

/** ログイン画面へ戻り先を渡すときのクエリ名。 */
export const RETURN_TO_PARAM = "return_to";

/** form で戻り先を持ち回すときの hidden input 名。クエリ名と揃える。 */
export const RETURN_TO_FIELD = RETURN_TO_PARAM;

/**
 * 戻り先として使ってよい値だけを返す。使えなければ null。
 */
export function sanitizeReturnTo(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;

  // `//evil.test/` と `/\evil.test` はブラウザが別オリジンの絶対 URL として
  // 解釈しうる。前方一致より先に落とす。
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;

  // 改行を含む値は、ヘッダ分割を狙った入力。Hono / workerd 側でも弾かれるが、
  // ここで落としておけば `Location` へ届く前に消える。
  if (/[\r\n]/.test(raw)) return null;

  if (raw !== ALLOWED_PREFIX && !raw.startsWith(`${ALLOWED_PREFIX}?`)) return null;

  return raw;
}

/**
 * 認可要求の URL を、ログイン後の戻り先として使える形に切り出す。
 *
 * ホスト部を落としてパス + クエリだけにする。絶対 URL のまま持ち回すと、
 * 「どのホストか」を検証する責務が戻り先を使うすべての箇所に増える。
 */
export function returnToForRequest(requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  return sanitizeReturnTo(`${url.pathname}${url.search}`);
}

/** 戻り先つきのログイン画面 URL。 */
export function loginUrlWithReturnTo(returnTo: string | null): string {
  if (returnTo === null) return "/login";
  return `/login?${RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`;
}
