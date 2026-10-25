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
 * @param {string} value `.env` の S3_ENDPOINT
 * @returns {URL} 検証済みのエンドポイント
 */
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
  return endpoint;
}
