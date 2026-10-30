/**
 * この Worker の島だけが作る要素のクラス（#332）。
 *
 * **一覧の行まわりは `@u18/web-ui/kiwa/island-classes` にある。**
 * nfc-worker も同じ見た目で出すので、Worker の外へ出した（#338）。
 * ここに残っているのは**この画面にしか出ないもの**だけ ——
 * プロフィールの編集パネルと、そこで使うボタン。
 *
 * **使う側が 2 つになったら、あちらへ移すこと。**
 *
 * ## なぜ島の中に直書きしないのか
 *
 * 島は DOM を手で組むので、`className = "..."` が 20 箇所以上ある。
 * **サーバーが描く同じ見た目の要素と、文字列が 2 箇所に分かれる。**
 * 片方だけ直すと、**一覧の行とボタンだけ見た目が違う**という形で出る ——
 * 落ちないし、スクリーンショットを見るまで分からない。
 *
 * ここを 1 つにして、画面（`*-page.tsx`）と島の両方がこれを読む。
 *
 * ## なぜ `cn()` を呼んでいないのか
 *
 * **島へ `cn` を持ち込まない。** `clsx` + `tailwind-merge` を esbuild で
 * 畳むと **27.8 KB** で、島そのもの（18.4 KiB）より大きい。取り消しが
 * できるようになる代わりに、読み込みが 2 倍になるのは釣り合わない。
 *
 * そのため**ボタンのクラスはリテラルで書いてある。**
 * `test/island-classes.test.ts` が `getButtonClasses()` の戻り値と
 * 突き合わせていて、**Kiwa 側が変わればここで落ちる。**
 *
 * ## ここは `kiwa-stylesheet.test.ts` の視界に入らないものがある
 *
 * あの検査は**サーバーが描いた HTML の class** しか見ない。島が後から
 * 足す要素（失敗の文言、処理中の表示）は、サーバー側のどこにも出ない
 * ので漏れる。**Tailwind の走査には入っている**
 * （`kiwa.css` の `@source "./"` がこのファイルを含む）が、
 * **`@source` を 1 行消せば黙って効かなくなる**ことは変わらない。
 */

/**
 * ボタンのクラス。**`getButtonClasses()` の戻り値をリテラルで写したもの。**
 *
 * `test/island-classes.test.ts` が突き合わせているので、Kiwa 側が
 * 変わればそこで落ちる。写し間違いも同じところで落ちる。
 */
const BUTTON_BASE =
  "inline-flex items-center justify-center whitespace-nowrap text-sm font-medium " +
  "transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] " +
  "focus-visible:ring-ring/20 aria-invalid:ring-destructive/20 " +
  "dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive " +
  "disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none " +
  '[&_svg:not([class*="size-"])]:size-4 shrink-0 [&_svg]:shrink-0';

const BUTTON_OUTLINE = "border border-border bg-card hover:bg-secondary hover:text-foreground";
const BUTTON_SIZE_SM = "h-8 rounded-lg gap-1.5 px-3 has-[>svg]:px-2.5";

/** ふつうのボタン（パスキーの登録、プロフィールの保存）。 */
export const BUTTON_CLASS = `${BUTTON_BASE} ${BUTTON_OUTLINE} ${BUTTON_SIZE_SM}`;

export const DANGER_BUTTON_CLASS = `${BUTTON_CLASS} text-destructive hover:text-destructive`;

/**
 * プロフィールの編集パネル（#312）。**島が囲いごと作る。**
 *
 * 見出しだけ先にサーバーが描くと、JS が落ちたときに**中身の無い
 * 「変更する」**が残る（`profile-page.tsx`）。そのため `Card` の
 * 中身をここで手で組んでいる。
 *
 * **`Card` と同じ値であることを `test/island-classes.test.ts` が
 * 確かめている** —— 実際に `<Card>` を描いて `class` を抜き、ここと
 * 突き合わせる。Kiwa 側が変わればそこで落ちる。
 */
export const PANEL_CLASS =
  "text-foreground flex flex-col gap-4 rounded-xl bg-card py-4 shadow-sm " +
  "[&_[data-slot=table-header]]:border-t";

/** `CardHeader` 相当。 */
export const PANEL_HEADER_CLASS =
  "grid auto-rows-min items-center gap-2 px-6 " +
  "has-data-[slot=card-action]:grid-cols-[1fr_auto] " +
  "has-data-[slot=card-description]:grid-rows-[auto_auto] " +
  "has-data-[slot=card-description]:items-start [.border-b]:pb-6";

/** `CardTitle` 相当。`<h2>` に付ける。 */
export const PANEL_TITLE_CLASS = "leading-none";

/** `CardDescription` 相当。 */
export const PANEL_DESC_CLASS = "text-foreground-muted text-sm";

/** `CardContent` 相当。 */
export const PANEL_BODY_CLASS = "px-6";

/** 入力欄 1 つ分（ラベル + input）。 */
export const FIELD_CLASS = "flex flex-col gap-1.5";

/** 入力欄そのもの。`theme.css` のトークンだけで組んである。 */
export const INPUT_CLASS =
  "h-9 w-full rounded-lg border border-border bg-background-subtle px-3 text-sm " +
  "outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] " +
  "focus-visible:ring-ring/20";

/** 入力欄のラベル。 */
export const LABEL_CLASS = "text-sm font-medium text-foreground-muted";
