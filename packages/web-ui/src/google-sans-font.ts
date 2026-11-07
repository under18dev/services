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
 *
 * ## `@u18/web-ui`（barrel）からは import しない
 *
 * **必ず `@u18/web-ui/google-sans-font` をサブパスで import すること。**
 * barrel（`src/index.ts`）は意図的にこのファイルを re-export していない
 * ——57,576 文字の base64 を `bytesFromBase64()` でデコードする呼び出しが
 * トップレベルにあり、esbuild は tree-shaking でこれを落とせない。barrel
 * 経由で 1 つでも import すると、フォントを配信していない Worker にまで
 * 57KB 強が巻き込まれる（`island-classes.ts` が `getButtonClasses()` で
 * 踏んだのと同じ形）。戻さないことを `test/bundle-size.test.ts` が検査する。
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

/**
 * `@font-face` の overlay（design-system 連携）。
 *
 * **vendored の `fonts.css`（design-system 側）は使わない。** あちらは
 * 3 本の `@font-face`（Google Sans / Google Sans Italic / Noto Sans JP）を
 * 相対パスの固定 URL で持つ——このリポジトリは URL に内容ハッシュを
 * 埋め込んで配信する仕組み（#211）なので、ビルド時に URL を埋め直す
 * 必要があるのと、積まないと決めた Italic・Noto Sans JP の 2 本が
 * 404 を引き続けることになる（`font-display: swap` なので画面は壊れないが、
 * 毎回失敗リクエストが出る）。ここでは **normal 1 本だけ**を持つ。
 *
 * **Italic は積んでいない。** u18 の画面・GDG の `components.css` の
 * どちらにも `italic` の指定や `<em>`/`<i>` が無いことを確認済み
 * （唯一 `.gdg-typography-blockquote` が要求するが、u18 に引用ブロックは
 * 無い）。**もし将来どこかで italic が必要になったら**、
 * `GoogleSans-Italic.woff2`（design-system 側に既にある、1,726,384 バイト）
 * を同じ手順でサブセットし、`font-style: italic` の `@font-face` を
 * もう 1 本ここに足すこと——ブラウザは `font-style: italic` の指定が無い
 * 要素に合成斜体（faux italic）をかけて描画するので、後から足しても
 * 既存画面は壊れない。
 *
 * **URL は相対パスにしてある。** `kiwa.css`（この文字列を末尾に足して
 * 配信する）と同じディレクトリに、同じ Worker がこのフォントを配信する
 * ことが前提——各 Worker の `asset-paths.ts` が `GOOGLE_SANS_FONT_ROUTE` を
 * `KIWA_STYLESHEET_ROUTE` と同じ接頭辞（`/ui/`）の下に置く。相対パスに
 * しておけば、4 Worker で接頭辞（`/ui/` 自体や `/account/ui/` 等）が
 * 違っても、この文字列は書き換えずに済む。
 *
 * **`@layer` の外に置く。** `kiwa.css` は `theme, base, gdg-tokens,
 * gdg-base, gdg-components, utilities` の順を明示しているが、
 * `@font-face` はこの中のどのレイヤーの対象でもない——フォント名を
 * 1 つ登録するだけで、このアプリに "Google Sans" という `@font-face` は
 * 他に無いので、レイヤーの優先順位が競合する相手が無い。無所属にして
 * レイヤー構成への依存を増やさない。
 */
export const GOOGLE_SANS_FONT_FACE_CSS = `/*
 * Google Sans（サブセット済み、design-system 連携の自前配信）。
 * normal 1 本だけ——Italic は積んでいない（@u18/web-ui の
 * google-sans-font.ts の GOOGLE_SANS_FONT_FACE_CSS を参照。将来
 * 必要になったら GoogleSans-Italic.woff2 を同じ手順でサブセットし、
 * font-style: italic の @font-face をもう 1 本足すこと）。
 */
@font-face {
  font-family: "Google Sans";
  src: url("./${GOOGLE_SANS_FONT_HASHED_NAME}") format("woff2");
  font-weight: 400 700;
  font-style: normal;
  font-display: swap;
}
`;
