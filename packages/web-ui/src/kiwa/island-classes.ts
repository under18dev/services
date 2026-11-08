/**
 * 一覧の行まわりの class（#332 / #338）。
 *
 * ## なぜ Worker の外にあるのか
 *
 * **dashboard-worker と nfc-worker が同じ見た目の行を出している。**
 * 補足の文、失敗の文言、「ありません」の表示 —— どれも**利用者からは
 * 1 つのダッシュボードに見える**ので、片方だけ変わると
 * 「NFC の画面だけ文字の色が違う」という形で出る。落ちないし、
 * 2 つの画面を並べて見るまで分からない。
 *
 * 並びを `@u18/contracts` へ出したのと同じ理由である（#338）。
 * 違いは、あちらが**トポロジ**（どの Worker がどの URL を持つか）で、
 * こちらは**語彙**（補足の文はこう見える）だということ。だから
 * 置き場所も `contracts` ではなく `web-ui` になる。
 *
 * ## **このファイルは何も import しない**
 *
 * **これが効く。** nfc-worker が `getButtonClasses()`（Kiwa の button）を
 * 自分の `island-classes.ts` で呼んだとき、島がそれを import した瞬間に
 * **`cn`（clsx + tailwind-merge）ごとバンドルへ入り、18.4 KiB の想定に
 * 対して 36.2 KiB になった**（実測）。**ビルドは成功し、テストも通る。
 * 大きさだけが言う。**
 *
 * **`./index.ts` からも再 export していない。** あれは `card.tsx` /
 * `button.tsx` を束ねているので、barrel 経由で読むと同じことが起きる。
 * 島から読むときは `@u18/web-ui/kiwa/island-classes` を**直接**指すこと。
 *
 * ## 何をここに置き、何を置かないか
 *
 * **2 つ以上の Worker が同じ見た目で出すもの**だけ。
 *
 * 置いていない例:
 *
 *  - dashboard のプロフィール編集パネル（島が `Card` 相当を手で組む）
 *  - nfc の遷移先の入力欄（Kiwa に input の primitive が無い）
 *
 * どちらも**1 つの画面にしか出ない**ので、持ち主の Worker に残してある。
 * **使う側が 2 つになった時点でここへ移すこと。**
 *
 * ## ここに入れても塞がらないもの
 *
 * **島が後から足す要素だけが持つ class は、サーバーの HTML に出ない。**
 * `kiwa-stylesheet.test.ts` が見ているのは描かれた HTML だけなので、
 * 失敗の文言や「保存中…」は視界に入らない。Tailwind の `@source` が
 * 拾ってはいるが、**設定を 1 行消せば黙って効かなくなる**ことは変わらない。
 * **全部を塞ぐより、どこが塞がっていないかが読めるほうを採っている。**
 */

/** 行の本体。失敗の文言はこの中へ足される。 */
export const ITEM_BODY_CLASS = "flex flex-col gap-1";

/** 行の見出し。バッジが隣に並ぶので折り返す。 */
export const ITEM_TITLE_CLASS = "flex flex-wrap items-center gap-2 font-medium";

/**
 * 行の補足。日付・種別・操作の結果。
 *
 * **成功と失敗で色を変えない**（design.md の "No colorful UI."）。
 * 失敗だけが下の `ITEM_ERROR_CLASS` で区別される。
 */
export const ITEM_META_CLASS = "text-sm/relaxed text-foreground-muted";

/**
 * 利用者が入れた値をそのまま出すところ（User-Agent、遷移先の URL）。
 *
 * **等幅で折り返す。** 長い URL が入れ物の幅を超えると横スクロールが出る。
 */
export const ITEM_RAW_CLASS = "font-mono text-xs break-all text-foreground-soft";

/** 失敗の文言。**読み上げにも出すので `role="alert"` と対で使う。** */
export const ITEM_ERROR_CLASS = "text-sm/relaxed text-destructive";

/**
 * 「ありません」の表示。
 *
 * **枠付きの `Empty` を使わない画面がある。** 島が最後の 1 件を消したあと
 * 同じ場所に `<p>` を作るので、サーバーだけ枠付きにすると**操作の前後で
 * 見た目が変わる。** 島が触らない画面（`/account/apps`）は `Empty` でよい。
 */
export const EMPTY_CLASS = "text-sm/relaxed text-foreground-muted";

/** 一覧。区切り線は行が自分で持つ。 */
export const LIST_CLASS = "flex flex-col";

/** 行の中のボタンを並べるところ。 */
export const ITEM_ACTIONS_CLASS = "mt-2 flex flex-wrap gap-2";

/**
 * 入力欄 1 つ分（ラベル + 入力）。
 *
 * **サーバーが描く画面（auth-worker のログイン）と、島が組み立てる
 * 画面（dashboard のプロフィール編集）の両方が使う。** 片方だけ変えると
 * 「編集のときだけ入力欄の見た目が違う」という形で出る。
 */
export const FIELD_CLASS = "flex flex-col gap-1.5";

/** 入力欄のラベル。 */
export const LABEL_CLASS = "text-sm font-medium text-foreground-muted";

/**
 * 入力欄そのもの。
 *
 * **Kiwa に input の primitive がまだ無い**ので、`theme.css` のトークン
 * から直に組んである。`registry/ui/input.tsx` を取り込んだ日に、この
 * 手書きが取り残される —— そのときは**サーバー側で
 * `getInputClasses()` 相当を呼んで渡す形**へ寄せること。
 * リテラルを残して突き合わせの検査を書く形は採らない（#332 で
 * 目で写した 7 本のうち 4 本が外れた）。
 */
export const INPUT_CLASS =
  "h-9 w-full rounded-lg border border-border bg-background-subtle px-3 text-sm " +
  "outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] " +
  "focus-visible:ring-ring/20";

/**
 * ボタン。**`getButtonClasses()` の戻り値をリテラルで写したもの。**
 *
 * 島は `getButtonClasses()` を**呼べない** —— `cn`（clsx +
 * tailwind-merge）ごとバンドルへ入るため（このファイルの冒頭）。
 * そこでリテラルを置き、**同じ値であることを
 * `apps/dashboard-worker/test/island-classes.test.tsx` が
 * `getButtonClasses()` と突き合わせている。** Kiwa 側が変われば落ちる。
 *
 * **写すのは目では無理だった。** 最初に書いた 7 本のうち 4 本が外れて
 * いる（`tailwind-merge` が衝突する class を落とすため）。
 * **サーバー側で呼んで渡せる場面では、そちらを使うこと** ——
 * 突き合わせの検査ごと要らなくなる。
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

/** ふつうのボタン（パスキーの登録・ログイン、プロフィールの保存）。 */
export const BUTTON_CLASS = `${BUTTON_BASE} ${BUTTON_OUTLINE} ${BUTTON_SIZE_SM}`;

/**
 * 取り消しのボタン——ただし破壊的な操作の全部ではない（issue #535、
 * 指摘: 3b）。
 *
 * **面を赤く塗らない。** 一覧の各行に 1 つずつ並ぶので、塗ると
 * `under18dev/under18dev` の `design.md`（u18 自身のデザイン方針、
 * GDG とは別物——`./README.md` の「色は design.md（`under18dev/
 * under18dev`）の値で」と同じ出どころ）が言う "No colorful UI." に
 * 当たる赤い面が画面を占める（承認者が 10 人いれば塗りの赤が 10 個
 * 並ぶ、という形）。文字だけ `--danger` にする。
 *
 * ## 破壊的な操作の重みは 3 段ある
 *
 * **分かれ目は「単独で出るか」でも「押した瞬間に戻れなくなるか」でもなく、
 * 「戻せるか」。**
 *
 * | 場面 | 使うもの | 具体例 |
 * | --- | --- | --- |
 * | 一覧の各行に 1 つずつ並ぶ破壊的操作 | `DANGER_BUTTON_CLASS` | — |
 * | **戻せる操作**（やり直せば元に戻る） | `DANGER_BUTTON_CLASS` | `POST /users/:userId/revoke-sessions`（`user-detail-page.tsx`「ログイン中の端末を全部切る」）。セッションを切られた人はログインし直せば戻れる——不便だが失われるものが無い |
 * | **戻せない確定操作**（確認カードの最終ボタン、対になる取り消し手段が無いもの） | `getButtonClasses("destructive", ...)` | 対になる enable ルートが存在しない `POST /clients/disable`（`clients.routes.tsx:223`）のような操作の確認ボタン |
 *
 * 「単独で出る確定操作だから塗り」という最初の案は、`revoke-sessions` で
 * 外れた——あれは詳細画面に単独で出るが、ログインし直せば戻るので
 * `DANGER_BUTTON_CLASS` のままでよい。**本当に見るべきは、対になる
 * 取り消し手段（reinstate・enable 相当）が存在するかどうか**——無ければ
 * 一番強い見た目（塗り）を取っておく。両方同じ強さだと、どちらが本当に
 * 戻れないのか画面から読めなくなる。
 *
 * **「戻せる」には 2 種類ある。** 1 つは自分（管理者）がもう一度操作すれば
 * 元に戻る形（`reinstate` 等）。もう 1 つは、管理者側に戻す手段が無くても
 * **本人のその後の行動で**戻る形——`nfc` の「手放させる」（release）は
 * 管理者が直接付け替えるエンドポイントを意図的に持たないが
 * （`release-card.use-case.ts` / `claim-card.use-case.ts`）、本人が
 * 再タップすれば自分で取り戻せるので、`revoke-sessions` と同じ「戻せる」
 * 側に置く。**「管理者が戻せないなら戻せない側」とは限らない**——次に
 * `release` のような操作を見た人が同じ早合点をしないよう、ここに残す。
 *
 * **この表は 2 つの正本を突き合わせた結果である。** `design.md`（u18）が
 * 面を赤く塗るなと言い、GDG の vendored `../gdg/components.css` が
 * 塗り（`.gdg-button-danger`、L122、`background: var(--gdg-danger)`）と
 * 柔らかい面（`.gdg-tone-danger`、L266、
 * `background: var(--gdg-danger-surface)`）の 2 段を用意している——
 * GDG が 2 つ用意しているのは使い分けろという意味だと読み、
 * `getButtonClasses("destructive")` を前者、この `DANGER_BUTTON_CLASS`
 * を後者に対応させた。上の行番号は vendored ファイルの更新でズレる。
 * `gdg-vendor-integrity.test.ts` が `components.css` を SHA-256 で
 * 固定しているので、ズレる更新は必ずそちらのテストが先に落ちる
 * （#542 で `--radius-lg` 等に同じ注記を入れたのと同じ形）。
 */
export const DANGER_BUTTON_CLASS = `${BUTTON_CLASS} text-destructive hover:text-destructive`;
