/**
 * age で暗号化したファイルの扱い（#325）。
 *
 * ## なぜ age なのか
 *
 * ダンプは**全利用者の平文メールアドレス**を含む。R2 の保存時暗号化だけでは、
 * **R2 のアクセス権を取った相手には平文**である。かといって共通鍵を CI に
 * 置くと、鍵も Cloudflare 側の管理下に入り、「**アカウントごと失う**」という
 * バックアップの前提そのものが崩れる。
 *
 * age の**公開鍵**で暗号化すれば、**CI に置くのは公開鍵だけ**で済む。
 * 復号できるのは運用者の手元の秘密鍵だけになる。自動化と鍵の分離が両立する。
 *
 * **その代償**: CI は自分が作ったバックアップを開けない。復元リハーサルは
 * 封をする前の平文に対して行い（`restore-rehearsal.mjs`）、
 * 「運用者の秘密鍵で実際に復号できる」ことは CI では言えない。
 * そこは runbook 12.11 の期限として `pnpm check:deadlines` に見させている。
 *
 * ## ここで鍵を作らない
 *
 * **作った側がそれを見たことになる。** 生成手順は runbook 12.11 にあり、
 * 実行するのは運用者である。このリポジトリのコードは公開鍵しか触らない。
 */

/**
 * age の出力はこの文字列で始まる（binary / armored とも、ヘッダは平文）。
 * 仕様: https://age-encryption.org/v1
 */
export const AGE_MAGIC = "age-encryption.org/v1";

/**
 * 受信者（公開鍵）の形を確かめる。
 *
 * **暗号学的な検証ではない。** `age` 自身が受け取ったときに弾くので、
 * ここで見るのは「**空の文字列や、秘密鍵をうっかり渡していないか**」である。
 * 秘密鍵は `AGE-SECRET-KEY-` で始まるので、**それを渡されたら必ず止める** ——
 * 渡された先がログや CI の出力に出ると、そこで漏れる。
 *
 * @param {unknown} recipient
 * @returns {string} 正規化した受信者
 */
export function assertRecipient(recipient) {
  if (typeof recipient !== "string" || recipient.trim() === "") {
    throw new Error("age の受信者（公開鍵）が空");
  }
  const value = recipient.trim();

  // **秘密鍵を受信者として渡す事故を止める。** 値そのものはエラーに出さない。
  if (value.toUpperCase().startsWith("AGE-SECRET-KEY-")) {
    throw new Error(
      "age の**秘密鍵**が受信者として渡された。公開鍵（age1... で始まる）を渡すこと。" +
        "この値は CI の設定から取り除き、鍵を作り直すこと",
    );
  }

  if (!value.startsWith("age1")) {
    throw new Error("age の受信者は age1... で始まる公開鍵でなければならない");
  }
  return value;
}

/**
 * バイト列が age の出力に見えるかを確かめる。
 *
 * **0 バイトや、何かの理由で平文のまま残ったファイルを「暗号化済み」として
 * 上げないため。** 暗号化が実際に正しく行われたかは、鍵を持っている人に
 * しか確かめられない —— ここで言えるのは「age の形をしている」までである。
 *
 * @param {Buffer} bytes
 * @param {string} label エラーに出す対象の名前
 */
export function assertAgeBytes(bytes, label) {
  if (bytes.length === 0) throw new Error(`${label} が空`);
  const head = bytes.subarray(0, AGE_MAGIC.length).toString("utf8");
  if (head !== AGE_MAGIC) {
    // **中身は出さない。** 平文だった場合、ここに個人情報が載る。
    throw new Error(`${label} が age の出力に見えない（暗号化されていない可能性がある）`);
  }
}

/**
 * `age` の実行ファイル。
 *
 * CI では公式リリースを SHA256 で固定して展開し、その場所を `AGE_BIN` で
 * 渡す（`.github/workflows/backup.yml`）。**PATH に入れないのは、
 * どの age を使ったかを設定から読めるようにするため。**
 */
export function ageBinary(env = process.env) {
  return env.AGE_BIN ?? "age";
}
