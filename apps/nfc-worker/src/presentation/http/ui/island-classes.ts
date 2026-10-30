/**
 * **アイランドが組み立てる class を、サーバーも使う**（#338）。
 *
 * ## なぜ定数にするのか
 *
 * Tailwind v4 は**ソースを走査して**使われている class だけを CSS に
 * 出す。`kiwa.css` の `@source "./"` は `client/` まで届いているが
 * （実測済み）、**設定を 1 行消した瞬間に黙って壊れる** —— class は
 * HTML に出るのに CSS が無い、という #320 と同じ形になる。
 *
 * **`kiwa-stylesheet.test.ts` が見ているのは「サーバーが描いた HTML」だけ**
 * なので、島が実行時に作る class はどのテストの視界にも入らない。
 *
 * ここへ出して**サーバー側も同じ定数を描く**と、
 *
 *  - 走査対象に必ず入る（import した側のファイルが走査される）
 *  - **既存の検査の視界に入る**（サーバーの HTML に現れるので）
 *
 * となり、**「島だけが使う class」という状態そのものが無くなる。**
 * 穴を塞ぐのではなく、穴が存在しうる状態を消している。
 *
 * ## 塞がっていないところ
 *
 * **島が後から足す要素だけが持つ class は、ここに入れてもサーバーの
 * HTML には出ない**（エラー表示や「保存中…」のような、最初は存在しない
 * もの）。それらは `@source` 任せのままである。**全部を塞ぐより、
 * どこが塞がっていないかが読めるほうを採った。**
 *
 * ## このファイルは何も import しない
 *
 * **これが効く。** 最初は `getButtonClasses()`（Kiwa の button）をここで
 * 呼んで `SAVE_BUTTON_CLASS` を export していた。島がこのファイルを
 * import した瞬間、**`cn`（clsx + tailwind-merge）ごとバンドルへ入り、
 * 島が 18.4 KiB の想定に対して 36.2 KiB になった**（実測）。
 *
 * **ビルドは成功する。テストも通る。大きさだけが言う。** #341 が
 * 「`cn` を島へ入れない」と書いていたのは、まさにこの経路である。
 *
 * だからここには**素の文字列だけ**を置く。`getButtonClasses()` が要る
 * ボタンの class は、**サーバー側のファイル（`cards-page.tsx`）で直接**
 * 呼ぶ —— あちらは島にバンドルされない。
 */

/**
 * 入力欄。**Kiwa に input の primitive がまだ無い**ので、トークンから直に組む。
 *
 * ## いまは突き合わせられない
 *
 * `SAVE_BUTTON_CLASS`（`cards-page.tsx`）は `getButtonClasses()` を
 * **サーバー側で呼んだ結果**なので、写し間違いが原理的に起きない。
 * こちらは**写した元が存在しない**ので、同じ守り方ができない。
 *
 * **`registry/ui/input.tsx` を取り込んだ日に、この手書きが取り残される。**
 * そのときは `SAVE_BUTTON_CLASS` と同じ形へ寄せること ——
 * **`getInputClasses()` 相当をサーバー側で呼び、結果を渡す。**
 * リテラルを残して突き合わせの検査を書く形は採らない：
 * d1 が dashboard でそれをやったとき、**目で写した 7 本のうち 4 本が
 * 外れていた**（`tailwind-merge` が衝突する class を落とすため）。
 * **検査が要らない形のほうが、検査がある形より上である。**
 */
export const TARGET_INPUT_CLASS =
  "w-full rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-sm " +
  "outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20";

/** 操作の結果を出す行。**成功と失敗で色を変えない**（design.md の "No colorful UI."）。 */
export const STATUS_TEXT_CLASS = "text-sm/relaxed text-foreground-muted";

/** 失敗だけは区別が要る。読み上げにも出すので `role="alert"` と対で使う。 */
export const STATUS_ERROR_CLASS = "text-sm/relaxed text-destructive";
