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
import { ADMIN_ISLAND_JS } from "./generated/admin-island.bundle";
import { KIWA_STYLESHEET } from "./generated/kiwa-stylesheet";

/** admin-worker はルート直下に載る（`/account` 接頭辞を持たない別オリジン）。 */
export const KIWA_STYLESHEET_ROUTE = `/ui/${hashedFileName("kiwa.css", KIWA_STYLESHEET)}`;
export const KIWA_STYLESHEET_PATH = KIWA_STYLESHEET_ROUTE;

/**
 * 並べ替え・絞り込み・コピー・タブ・通知のアイランド（#470）。
 *
 * **個人情報を含まない。** CSS と同じく全利用者（運営）に同じ中身で、
 * `PUBLIC_PATHS` にも入れてよい——`app.tsx` を参照。
 */
export const ISLAND_ROUTE = `/ui/${hashedFileName("admin-island.js", ADMIN_ISLAND_JS)}`;
export const ISLAND_PATH = ISLAND_ROUTE;
