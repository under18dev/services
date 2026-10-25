/**
 * `S3_ENDPOINT` の検証（#164 の後続 / CodeQL `js/file-access-to-http`）。
 *
 * ここを通った認証情報で送るのは **D1 の完全な複製**で、`users` /
 * `user_emails` / `email_challenges` の**平文メールアドレス**が入っている。
 * `S3_ENDPOINT` を `http://` にすると、それが暗号化されずに流れる。
 *
 * **存在の確認だけでは足りない。** 設定ミスや、手元での動作確認のつもりで
 * 書いた `http://` が、そのまま本番の退避経路になりうる。`.env` は
 * gitignore 済みで誰のレビューも通らないので、**気づく機会がここしかない。**
 *
 * ## 宛先そのものも確かめる（CodeQL の 5 件）
 *
 * https であることは「盗み見られない」を保証するだけで、**正しい相手へ
 * 送っていることは何も保証しない。** `.env` が書き換わる、あるいは単に
 * 打ち間違えると、**Identity DB の完全な複製が別の宛先へ届く。**
 * CodeQL の `js/file-access-to-http` が指しているのはこの形で、
 * 「意図した送信だから」で片付けると、意図しない宛先への送信も通る。
 *
 * そこでホストを R2 に限る。正当な用途は何も妨げない —— このスクリプトは
 * R2 専用で、他の宛先へ送る理由が無い。**抜け道（環境変数で無効化できる等）
 * は作らない。** 作ると、急いでいる人が必ずそれを使う。
 *
 * ## `hostname` で見る。生の文字列の後方一致にしない
 *
 * これは実際に抜けられる:
 *
 * ```js
 * "https://evil.example/#.r2.cloudflarestorage.com".endsWith(".r2.cloudflarestorage.com") // true
 * "https://evil.example/?x=.r2.cloudflarestorage.com".endsWith(".r2.cloudflarestorage.com") // true
 * ```
 *
 * fragment もクエリも末尾に付けられるので、**URL 文字列の後方一致は
 * 宛先の判定にならない。** パーサを通した `hostname` を見る。
 *
 * `presentation/http/ui/return-to.ts` は**逆**をやっている —— あちらは
 * `new URL()` の解釈に委ねず生の文字列で前方一致する。**先頭は
 * 「パスかどうか」をパーサ無しで決められるが、末尾は「ホストかどうか」を
 * パーサ無しでは決められない**、という差である。
 *
 * @param {string} value `.env` の S3_ENDPOINT
 * @returns {URL} 検証済みのエンドポイント
 */
/** R2 のエンドポイントのホスト接尾辞。先頭の `.` を含めることが肝。 */
const R2_HOST_SUFFIX = ".r2.cloudflarestorage.com";

export function assertHttpsEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`S3_ENDPOINT が URL として読めない: ${value}`);
  }
  if (endpoint.protocol !== "https:") {
    throw new Error(
      `S3_ENDPOINT は https でなければならない（平文のメールアドレスを送るため）: ${endpoint.protocol}//`,
    );
  }
  // `.r2.cloudflarestorage.com` のサブドメインだけ。`evil-r2.cloudflarestorage.com`
  // のような「点を挟まない前置き」は、先頭の `.` を要求しているので通らない。
  if (!endpoint.hostname.endsWith(R2_HOST_SUFFIX)) {
    throw new Error(
      `S3_ENDPOINT の宛先が R2 ではない（D1 の完全な複製を送るので宛先を限っている）: ${endpoint.hostname}`,
    );
  }

  return endpoint;
}
