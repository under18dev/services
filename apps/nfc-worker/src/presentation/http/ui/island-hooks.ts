/**
 * **島とサーバーが同じ目印を見る**（#338）。
 *
 * ## なぜ定数にするのか
 *
 * 島は `querySelector("[data-card-target-input]")` で要素を引く。
 * **見た目の class で引かない** —— Tailwind の class は移行のたびに
 * 変わる前提のもので、しかも `?.` で繋ぐと**一致しなくなっても例外が
 * 出ない**（#341）。エラーは出ず、操作だけが黙って効かなくなる。
 *
 * `data-*` にしても、**名前の食い違い**は同じ形で起きる。両端が同じ
 * 定数を見ていれば、そこは消える。
 *
 * ## 定数では防げないもの
 *
 * **サーバーがその要素を描き忘れる**ほうは、定数では防げない（d1 の
 * 指摘）。同じ名前を見ていても、出力に無ければ島は何も見つけられず、
 * やはり例外は出ない。**そちらは「実際に描いて島が引ける」ことを
 * テストで見る**（`test/cards.island-hooks.test.ts`）。
 *
 * ## このファイルは何も import しない
 *
 * 島にバンドルされる側なので、ここから重いものへ辿れるようにしない
 * （`island-classes.ts` と同じ理由。`cn` を引き込んで島が 36.2 KiB に
 * なった実測がある）。
 */

/** カード 1 枚ぶんの操作のまとまり。`data-card-id` を併せ持つ。 */
export const TARGET_FORM = "data-card-target-form";

/** そのカードの ID。島は URL の組み立てに使う。 */
export const CARD_ID = "data-card-id";

/** 遷移先の入力欄。 */
export const TARGET_INPUT = "data-card-target-input";

/** 保存ボタン。 */
export const TARGET_SAVE = "data-card-target-save";

/** 結果を出す行。**サーバーが空で描き、島が埋める。** */
export const TARGET_STATUS = "data-card-target-status";

/**
 * 片道の操作のまとまり（#382）。`data-card-id` を併せ持つ。
 *
 * **`TARGET_FORM` と分けてある。** あちらは何度でもやり直せる操作で、
 * こちらは**戻せない／戻しても宙に浮く**操作である。同じ入れ物に混ぜると、
 * 島の側で「どちらの結果を出す行か」が曖昧になる。
 */
export const ACTIONS_ROW = "data-card-actions";

/** 止める（無効化）。**片道。** */
export const DISABLE_BUTTON = "data-card-disable";

/** 人にゆずる（手放す）。**次にタップした人のものになる。** */
export const RELEASE_BUTTON = "data-card-release";

/** 片道の操作の結果を出す行。**サーバーが空で描き、島が埋める。** */
export const ACTION_STATUS = "data-card-action-status";
