import { bytesFromBase64 } from "./binary-asset";
import { hashedFileName } from "./asset-hash";
import { GOOGLE_SANS_FONT_BASE64 } from "./generated/google-sans-font";

/**
 * Google Sans（サブセット済み）の配信用バイト列。
 *
 * design-system（gdg-jp/design-system）の `assets/fonts/GoogleSans.woff2`
 * を元に、英数字・一般約物だけに絞ったもの（`scripts/subset-google-sans.mjs`
 * を参照）。4 Worker（auth / dashboard / nfc / admin）が同じ中身を配信する
 * ので、生成は 1 箇所（ここ）だけで行い、各 Worker はこの定数を import する
 * だけにする——`kiwa.css` のように Worker ごとに中身が変わるものではない。
 *
 * **モジュールのトップレベルで 1 回だけデコードする。** 各 Worker の配信
 * ルートはこの `Uint8Array` をそのまま使い回すこと（`binary-asset.ts` の
 * JSDoc を参照）。
 */
export const GOOGLE_SANS_FONT_BYTES = bytesFromBase64(GOOGLE_SANS_FONT_BASE64);

/**
 * URL に使うファイル名のベース。内容ハッシュは呼び出し側で
 * `hashedFileName(GOOGLE_SANS_FONT_FILE_NAME, GOOGLE_SANS_FONT_BASE64)`
 * のように付けること（他のアセットと同じく、ハッシュ元は配信する文字列
 * そのもの——base64 文字列——から計算する）。
 */
export const GOOGLE_SANS_FONT_FILE_NAME = "google-sans.woff2";

/** `asset-paths.ts` がそのまま使えるよう、ハッシュ付きの相対パスも用意する。 */
export const GOOGLE_SANS_FONT_HASHED_NAME = hashedFileName(
  GOOGLE_SANS_FONT_FILE_NAME,
  GOOGLE_SANS_FONT_BASE64,
);
