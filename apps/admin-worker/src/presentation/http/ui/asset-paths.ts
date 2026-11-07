/**
 * admin-worker が配信する静的アセットのパス（#390 決定 16 ③）。
 *
 * **ページ側（`<link>`）と配信ルートの両方がここを見る。** 文字列を
 * 各所に直接書くと、パスを変えたときに片方だけ直る —— ページは古い
 * パスを参照し続け、ブラウザが 404 を踏むだけで型検査もテストも
 * 何も言わない（auth-worker / nfc-worker の同名ファイルと同じ理由）。
 *
 * ## URL に内容ハッシュが入る（#211）
 *
 * `hashedFileName()` が配信する文字列そのものからファイル名を作るので、
 * 中身が変われば URL も変わる。実行時に決まるので、テストやページから
 * 文字列を書き写さないこと。ここを import すれば常に正しい値になる。
 */
import { hashedFileName } from "@u18/web-ui";
import {
  GOOGLE_SANS_FONT_FACE_CSS,
  GOOGLE_SANS_FONT_HASHED_NAME,
} from "@u18/web-ui/google-sans-font";
import { ADMIN_ISLAND_JS } from "./generated/admin-island.bundle";
import { KIWA_STYLESHEET } from "./generated/kiwa-stylesheet";

/**
 * Kiwa のスタイルシートに Google Sans の `@font-face` を足したもの
 * （design-system 連携）。
 *
 * **ここで連結する。** `build-client.mjs` は Tailwind を回すだけで、
 * フォントの URL（内容ハッシュ入り）は TS 側でしか計算できない——
 * `@u18/web-ui/google-sans-font` の extensionless な相対 import が
 * plain `node` では解決できないため、生成スクリプトから直接 import
 * できない（`google-sans-font.ts` の JSDoc も参照）。
 *
 * **ハッシュは連結後の文字列から計算する。** 下の `KIWA_STYLESHEET_ROUTE` が
 * `hashedFileName` へ渡すのは `KIWA_STYLESHEET` 単体ではなくこの定数——
 * `@font-face` を足した分だけ配信する中身が変わっているので、そこも
 * ハッシュに含めないと「中身が変われば URL も変わる」（#211）が崩れる。
 */
export const KIWA_STYLESHEET_WITH_FONTS = `${KIWA_STYLESHEET}\n${GOOGLE_SANS_FONT_FACE_CSS}`;

/** admin-worker はルート直下に載る（`/account` 接頭辞を持たない別オリジン）。 */
export const KIWA_STYLESHEET_ROUTE = `/ui/${hashedFileName("kiwa.css", KIWA_STYLESHEET_WITH_FONTS)}`;
export const KIWA_STYLESHEET_PATH = KIWA_STYLESHEET_ROUTE;

/**
 * サブセット済み Google Sans 本体（design-system 連携）。
 *
 * **`KIWA_STYLESHEET_ROUTE` と同じ接頭辞（`/ui/`）に置く。** `@font-face` の
 * `src` は相対パス（`./<hash>.woff2`）で書いてあるので
 * （`google-sans-font.ts` を参照）、スタイルシートと同じディレクトリに
 * 無いと 404 になる。
 */
export const GOOGLE_SANS_FONT_ROUTE = `/ui/${GOOGLE_SANS_FONT_HASHED_NAME}`;
export const GOOGLE_SANS_FONT_PATH = GOOGLE_SANS_FONT_ROUTE;

/**
 * 並べ替え・絞り込み・コピー・タブ・通知のアイランド（#470）。
 *
 * **個人情報を含まない。** CSS と同じく全利用者（運営）に同じ中身で、
 * `PUBLIC_PATHS` にも入れてよい——`app.tsx` を参照。
 */
export const ISLAND_ROUTE = `/ui/${hashedFileName("admin-island.js", ADMIN_ISLAND_JS)}`;
export const ISLAND_PATH = ISLAND_ROUTE;
