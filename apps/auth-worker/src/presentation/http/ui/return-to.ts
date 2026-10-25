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
 * ## 採った方針: 許可リストで、決め打ちのパスだけ
 *
 * 「同一オリジンなら許す」でも「相対パスなら許す」でもなく、
 * **列挙した接頭辞で始まる相対パスだけ**を通す。
 *
 * - 戻り先が要る経路は限られている。認可フロー（`/oauth/authorize`）と、
 *   未ログインで弾かれたアカウント管理画面（`/account`）の 2 つ。
 *   **先回りして広げない** —— 増えたらここへ足す。
 * - 「相対パスなら安全」は成り立たない。`//evil.test/` と `/\evil.test` は
 *   ブラウザによって別オリジンの絶対 URL として解釈される。
 *   先頭 2 文字を見るだけの実装はここで落ちる。
 * - 判定を `new URL()` の解釈に委ねない。基準 URL の与え方次第で
 *   結果が変わるので、生の文字列に対する前方一致で決める。
 *
 * 不正な値は**エラーにせず捨てる**。利用者から見れば「ログイン後に
 * トップへ戻った」だけで、やり直せる。
 */

/**
 * 戻り先として受け付けるパスの接頭辞。
 *
 * `/account` は dashboard-worker と nfc-worker の画面が載る接頭辞で、
 * **同一ホストの別 Worker**（§14.1 決定 1）。未ログインで弾かれた画面へ
 * 戻すために要る。`/account/sessions` のような下位パスも通す。
 */
const ALLOWED_PREFIXES = ["/oauth/authorize", "/account"] as const;

/**
 * ログイン画面へ戻り先を渡すときのクエリ名。
 *
 * **実体は `@u18/contracts`。** 他の Worker（dashboard / nfc）も同じ名前で
 * 渡してくるので、ここで独自に定義すると片方を直し忘れた瞬間に
 * 「ログインはできるが元の画面へ戻らない」という、誰も落ちないまま
 * 壊れる形になる。
 */
export { RETURN_TO_PARAM } from "@u18/contracts";
import { RETURN_TO_PARAM as CONTRACT_RETURN_TO_PARAM } from "@u18/contracts";

/** form で戻り先を持ち回すときの hidden input 名。クエリ名と揃える。 */
export const RETURN_TO_FIELD = CONTRACT_RETURN_TO_PARAM;

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

  // **`..` を含む値は捨てる。**
  //
  // 下位パス（`/account/sessions`）を許すために接頭辞の直後の `/` を
  // 通すようにしたが、そのままだと `/oauth/authorize/../../evil` が
  // 接頭辞に一致してしまう。ブラウザは `Location` を正規化するので
  // 実際には `/evil` へ飛ぶ。**許可リストを素通りする。**
  //
  // 以前は「ちょうど一致」か「`?` が続く」しか許していなかったので
  // この形は構造的に入らなかった。下位パスを許した時点で入口ができる
  // ——既存のテストがそれを捕まえた。
  if (raw.split(/[?#]/)[0]?.split("/").includes("..") === true) return null;

  // **接頭辞の直後を見る。** 前方一致だけだと `/accountevil` が通る。
  // 許すのは「ちょうど一致」「`?` が続く」「`/` が続く」の 3 つだけ。
  const allowed = ALLOWED_PREFIXES.some(
    (prefix) => raw === prefix || raw.startsWith(`${prefix}?`) || raw.startsWith(`${prefix}/`),
  );
  if (!allowed) return null;

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

/**
 * 戻り先つきのログイン画面 URL。
 *
 * **実体は `@u18/contracts`。** dashboard / nfc も同じ形で組み立てるので、
 * ここで独自に持つと符号化の仕方がずれる余地ができる。
 */
export { loginUrlWithReturnTo } from "@u18/contracts";
