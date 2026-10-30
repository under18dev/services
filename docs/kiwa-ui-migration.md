# Kiwa UI 移行 —— 残り 5 枚の下調べ

- Status: **完了（2026-10-30）。** P1（残り 5 枚 + `message-page`）は #347 ほかで、P2（ログイン #351 / 同意 #352）と `styles.ts` の削除まで入った。**本書は設計時のまま残してある** —— 実装後に書き直すと、「何を決めたか」と「何がそうなったか」の区別が消えるため。いまの姿はコード側のコメントを読むこと。
- Date: 2026-10-30
- **改訂: #342（P0）のマージ後に書き直した。** 初版は P0 の前に書いたもので、「Tailwind をどう繋ぐか」「どの primitive を取り込むか」が未定という前提だった。**それらは決着したので、本書は決まったものの上で残りを設計する。** 初版との差は §7。
- 追跡 issue: [#332](https://github.com/under18dev/services/issues/332)
- 対象: **残り 5 枚**（`/account` ホーム / profile / passkeys / sessions / grants）と、**同じ URL に出る `message-page.tsx`**

---

## 0. 先に結論

1. **取り込んである 6 つでは足りない。足りないのは 1 つ、`button.tsx` だけ。**
   5 枚すべてにボタンがある（ホームの導線 `<a>`、取り消し、パスキー登録、保存）、
   いま押せるものを描く手段が無い（§3.1）。
2. **`KiwaShell` に `scripts` と `<noscript>` が無い。** 残り 5 枚のうち 4 枚は
   アイランドを読み、3 枚は外枠に `<noscript>` を出させている。**見本の 1 枚が
   JS を 1 行も使わない画面だったので、まだ要らなかっただけ**である（§3.2）。
3. **アイランドの本当の問題はクラス名ではなく、セレクタである。**
   `querySelector(".item-main")` のように**見た目のクラスで DOM を引いている**。
   Tailwind へ移すと一致しなくなるが、`?.` で繋いであるので**例外も出ずに
   黙って何もしない。** クラス名の定数化より先にこちらを直す（§4.2）。
4. **5 枚を移しても `styles.ts` は消えない。** auth-worker が 17 個のクラスと
   `:root` のトークン一式を握っている。消えるのはダッシュボード専用の 36 個（§5）。
5. **`Badge variant="secondary"` は使えない。** 上流の綴りが `border-subtle` で、
   このトークンは存在しない。**class は出るが CSS が無い**（§3.5）。`SidebarItemBadge`
   がこの variant を直に指定しているので、巻き込まれる。

---

## 1. P0 で決まったこと（本書の前提）

### 1.1 入口と、取り込んである primitive

```
import { … } from "@u18/web-ui/kiwa";
```

| ファイル           | export                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `alert.tsx`        | `Alert` `AlertContent` `AlertTitle` `AlertDescription` `AlertClose`                       |
| `badge.tsx`        | `Badge`                                                                                   |
| `card.tsx`         | `Card` `CardHeader` `CardTitle` `CardDescription` `CardAction` `CardContent` `CardFooter` |
| `empty.tsx`        | `Empty` `EmptyHeader` `EmptyMedia` `EmptyTitle` `EmptyDescription` `EmptyContent`         |
| `separator.tsx`    | `Separator`                                                                               |
| `sidebar-item.tsx` | `SidebarItem` `SidebarItemButton` `SidebarItemBadge` `sidebarItemVariants`                |
| `utils.ts`         | `cn`                                                                                      |

**本体（`@u18/web-ui`）からは再 export されていない。** どちらの流儀で書かれた画面かを
import から読めるようにするためで、移行が終わるまでこの形が続く（`kiwa/index.ts`）。

足すときの手順は `packages/web-ui/src/kiwa/README.md` にある。
**`registry/blocks/pro/` は持ってこないこと**（別ライセンス）。

### 1.2 初版が「決めてほしい」と書いた 2 点の答え

| 初版の問い                           | P0 の答え                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Card` に枠線を足すか                | **足さない。** `theme.css` が `--shadow-sm: 0 0 0 1px var(--border)` にしてあり、`Card` の既定の `shadow-sm` がそのまま `.panel` の `1px solid var(--border)` と同じ輪郭を出す。`class="border border-border"` を書くと**二重になる** |
| 素の要素セレクタとカスケードレイヤー | **混ぜない形で回避した。** 1 枚のページは片方の CSS しか読まない。`ui-pages.test.ts` が `<link rel="stylesheet">` が**ちょうど 1 本**であることを見ている（§6.1）                                                                     |

### 1.3 `/account/apps` が作った前例

**残り 5 枚はこの書き方に揃える。** ばらけると「同じサイトで画面ごとに流儀が違う」になる。

| 事柄              | 前例                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 一覧の行の区切り  | `<ul class="flex flex-col">` + `{index > 0 && <Separator class="my-3" />}`。**1 件目の前に置かない**（`CardHeader` の下線と線が 2 本並ぶ） |
| 0 件              | `Empty` + `EmptyHeader` + `EmptyTitle` + `EmptyDescription`。**0 件のときは `Card` を描かない**                                            |
| 補足の警告        | `Alert`（既定）+ `AlertDescription`                                                                                                        |
| バッジ            | `<Badge>`（既定 = `bg-primary-soft` の塗り）。初版が薦めた `variant="outline-primary"` は**採られていない**                                |
| 本文中のリンク    | `class="text-foreground underline underline-offset-4"`                                                                                     |
| 外部 URL の文字列 | `class="font-mono text-xs break-all text-foreground-soft"`                                                                                 |
| テストの目印      | **`data-slot` を見る。見た目の class を目印にしない**（`ui-pages.test.ts` のコメント）                                                     |

### 1.4 トークンで気をつけること

- **`--success` / `--warning` / `--info` に色が当たっていない**（`--foreground-muted` に倒してある）。
  `variant="success"` は**既定と同じ見た目になる**。壊れはしないが、色で状態は言えない。
  **色で言いたければ design.md に色を足す決定が先**（`theme.css` の当該コメント）
- 有彩色は `--primary`（青）と `--destructive`（赤）の 2 つだけ
- **`theme.css` に無いトークンのユーティリティは Tailwind が生成しない。**
  class は HTML に出るのに CSS が無い、という #320 と同じ形になる

---

## 2. 5 枚の棚卸しと対応表

### 2.1 画面ごと

| 画面               | いま使っているクラス                                                                                                                                                                                             | アイランド | `<noscript>` |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------: | :----------: |
| `/account`（home） | `stack` `cards` `cards-3` `panel` `panel-header` `panel-title` `panel-desc` `panel-body` `stat` `stat-value` `stat-label` `list` `item-main` `item-title` `item-meta` `button` `button-secondary` `button-small` |     —      |      —       |
| profile            | `panel` `panel-body` `facts` `badge` `badge-warn` `notice`                                                                                                                                                       |     ○      |      ○       |
| passkeys           | `panel` `panel-body` `panel-footer` `list` `item-main` `item-title` `item-meta` `empty`                                                                                                                          |     ○      |      ○       |
| sessions           | `panel` `panel-body` `section-lead` `list` `item-main` `item-title` `item-meta` `item-raw` `badge` `empty`                                                                                                       |     ○      |      ○       |
| grants             | `panel` `panel-body` `list` `item-main` `item-title` `item-meta` `scopes` `empty`                                                                                                                                |     ○      |      ○       |
| **message-page**   | `panel` `panel-body` `section-lead` `links`                                                                                                                                                                      |     —      |      —       |

`<noscript>` の出どころは 2 つある。passkeys / sessions / grants は外枠（`DashboardShell` の
`hasRevokeActions`）が出し、**profile だけは画面が自分で書いている**。移すときに
profile のぶんを見落としやすい。

**`message-page.tsx` を 5 枚と一緒に移すこと（§2.2）。**

### 2.2 6 枚目がある —— `message-page.tsx`

`SignInRequiredPage` と `UnavailablePage` は、**上の 6 つの URL すべてで出る**
（`account.routes.tsx` の `signInRequired` / `renderFailure`。401 と 503）。
`DashboardShell`（手書き CSS）で組まれているので、いまこうなっている。

> **`/account/apps` は、ログインしていれば Kiwa、ログインしていなければ手書き CSS。**
> 同じ URL で、見た目の流儀が 2 つある。

`ui-pages.test.ts` の `EXPECTED_STYLESHEET` は**必ず Cookie を付けて**取りに行くので、
この経路を見ていない。**P0 の落ち度ではなく、見本 1 枚では現れない形**である。
5 枚を移すときに `message-page.tsx` も一緒に移し、**401 / 503 側も見るように
テストを足すこと**（§6.1）。

### 2.3 クラス → 置き換え

`/account/apps` の前例（§1.3）に揃えたもの。初版から変わった行には ← を付けた。

| 既存クラス                                                     | 置き換え                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `.panel`                                                       | `Card`。**枠線を足さない**（§1.2）←                                                                  |
| `.panel-header` / `.panel-title` / `.panel-desc`               | `CardHeader` / `CardTitle` / `CardDescription`                                                       |
| `.panel-body` / `.panel-footer`                                | `CardContent` / `CardFooter class="border-t"`                                                        |
| `.list`                                                        | `<ul class="flex flex-col">` + 間に `<Separator class="my-3" />`。**初版の `divide-y` は採らない** ← |
| `.list > li`                                                   | `<li>` + `<div class="flex items-start justify-between gap-5">`                                      |
| `.item-main`                                                   | `min-w-0`                                                                                            |
| `.item-title`                                                  | `font-medium break-all`（`/account/apps` が `break-all` を使っている）←                              |
| `.item-meta`                                                   | `text-sm/relaxed text-foreground-muted` ←                                                            |
| `.item-raw`                                                    | `font-mono text-xs break-all text-foreground-soft` ←                                                 |
| `.item-actions`                                                | `shrink-0`                                                                                           |
| `.empty`                                                       | `Empty` + `EmptyHeader` + `EmptyTitle`（**ただし §4.5 を読むこと**）←                                |
| `.badge`                                                       | `<Badge>`（既定）←                                                                                   |
| `.badge-warn`                                                  | `<Badge variant="destructive">`。**`variant="warning"` は無彩色なので「注意」に読めない**（§1.4）←   |
| `.notice`（`<noscript>` の中）                                 | `Alert` + `AlertDescription`                                                                         |
| `.section-lead` / `.lead`                                      | `text-sm/relaxed text-foreground-muted`                                                              |
| `.links`                                                       | `text-sm` + リンクに `text-foreground underline underline-offset-4`                                  |
| `.stack`                                                       | `KiwaShell` が本文に `flex flex-col gap-8` を持っているので**不要**。直接子を並べる ←                |
| `.cards` `.cards-3`                                            | `grid gap-5 grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]`                                          |
| `.button` `.button-secondary` `.button-small` `.button-danger` | **`button.tsx` を取り込む**（§3.1）                                                                  |
| `.facts`                                                       | primitive 無し。§3.3                                                                                 |
| `.stat` `.stat-value` `.stat-label`                            | primitive 無し。§3.3                                                                                 |
| `.scopes`                                                      | primitive 無し。§3.3                                                                                 |

---

## 3. 6 つで足りるか

### 3.1 足りないのは `button.tsx` 1 つ

**5 枚すべてにボタンがある。**

| 画面                         | 何のボタンか                                               | いまのクラス                                         |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| home                         | 「パスキーの設定へ」（**`<a>`**、パスキー 0 件のときだけ） | `button button-secondary button-small`               |
| passkeys                     | 「パスキーを登録」（アイランド）                           | `button button-secondary`                            |
| profile                      | 「保存」（アイランド）                                     | `button`                                             |
| passkeys / sessions / grants | 取り消し（アイランド）                                     | `button button-secondary button-small button-danger` |

`registry/ui/button.tsx` は **CSP にも JS 無しにも引っかからない**
（インライン `style=` を出さず、`data-*` のトリガも持たない）。

**取り込む価値が特に高い理由が 1 つある。**

```ts
export const buttonBaseStyles = cn(…);
export function getButtonClasses(variant = "default", size = "default"): string;
```

**クラス文字列を関数として export している。** ほかの primitive は class を
コンポーネントの中に埋めているので、**DOM を手で組むアイランドからは使えない。**
`button.tsx` だけはアイランドからも同じ見た目を出せる（§4.3）。

対応は `.button*` の 4 つに対してこうなる。

| 既存                | `button.tsx`                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `.button`           | `variant="default"`                                                                                        |
| `.button-secondary` | `variant="outline"`（`secondary` は塗りが入る）                                                            |
| `.button-small`     | `size="sm"`                                                                                                |
| `.button-danger`    | `variant="outline" class="text-destructive"`。**`variant="destructive"` は塗り**で、既存は文字色と枠線だけ |

home の導線は `<a>` のままにして `class={getButtonClasses("outline", "sm")}` を当てる。
**`<button>` にしない** —— 遷移であって操作ではないので、中クリックや
新しいタブで開けなくなる。

### 3.2 `KiwaShell` に足りない 2 つ

```ts
export type KiwaShellProps = {
  title;
  current?;
  heading;
  lead?;
  children?;
};
```

`DashboardShell` が持っていて `KiwaShell` に無いものが 2 つある。

1. **`scripts`。** 残り 5 枚のうち 4 枚が `scripts={[ISLAND_PATH]}` を渡す。
   `Layout` 側は `scripts` を受け取れるので、`KiwaShell` が素通しするだけでよい
2. **`hasRevokeActions`（`<noscript>` の案内）。** passkeys / sessions / grants の 3 枚が
   「取り消しには JS が要る」「全端末ログアウトは JS 無しでも使える」を出している。
   **消さずに `Alert` + `AlertDescription` で組み直す**

**見本の 1 枚が JS を使わない画面だったので要らなかっただけ**で、`KiwaShell` の
設計ミスではない。P1 の最初の 1 コミットで足すのが素直。

なお `kiwa-shell.tsx` の冒頭が「NFC（#338）が同じ外枠を読むので packages 側へ移る見込み。
そのとき `stylesheet` と並びを**引数で受け取る形**にすること」と書いている。
**NFC は別のセッションが担当している**ので、`KiwaShell` に手を入れるときは
そちらと衝突しないか先に確かめること。

### 3.3 primitive が無いまま組むもの（追加の取り込みは不要）

| 対象                           | 組み方                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.facts`（profile の `<dl>`）  | 定義リストの primitive は `registry/ui` に無い。`Card` > `CardContent` > `<dl>`、行は `<div class="flex gap-5 py-3">` + `<dt class="w-30 shrink-0 text-sm text-foreground-muted">` + `<dd class="m-0 min-w-0 break-all">`、行間に `<Separator />`                                                     |
| `.stat`（home の数値タイル）   | 数値タイルは Pro 側。`Card class="p-0"` の中に `<a class="block px-6 py-5 hover:bg-secondary">`、`<span class="block text-[1.75rem] font-semibold tracking-tight">` + `<span class="mt-0.5 block text-sm text-foreground-muted">`。**リンク全体が押せる形を保つ**（いまの `.stat` が `<a>` そのもの） |
| `.scopes`（grants の権限一覧） | 箇条書きの primitive は無い。`<ul class="mt-1.5 flex flex-col gap-0.5 pl-5 text-sm text-foreground-soft list-disc">`                                                                                                                                                                                  |

**この 3 つのために primitive を取りに行かないこと。** `registry/ui` にある
それらしいもの（`table.tsx` / `display-card.tsx` / `content-card.tsx`）は、
どれも**この 3 つとは別の形**で、合わせるほうが手間が増える。

- `table.tsx` —— `.facts` も `.list` も**0 件になりうる**。ヘッダ行だけが残る表になる
- `display-card.tsx` —— `variant="primary"` が `bg-primary-mesh`（グラデーション）。
  `theme.css` は**このトークンを持ってきていない**ので、使うと CSS の無い class が出る

### 3.4 取り込まないもの（検討して外したもの）

| 候補                                                                                                    | 外す理由                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidebar-collapsible.tsx`                                                                               | `style="max-height: 0px"` を出す。CSP で捨てられ、`hidden` だけが残って**中身が出ない**。畳みたくなったら `<details>` / `<summary>` で組む                                                                               |
| `progress.tsx` `slider.tsx` `placeholder-gradient.tsx` `blog-post-card.tsx`                             | 同じくインライン `style=`。後ろ 2 つはグラデーションでもある                                                                                                                                                             |
| `tabs.tsx` `dialog.tsx` `accordion.tsx` `collapsible.tsx` `dropdown-menu.tsx` `popover.tsx` `sheet.tsx` | JS が無いと中身が `hidden` のまま消える。**5 枚はどれも「一覧が JS 無しで読める」が要件**                                                                                                                                |
| `tooltip.tsx`                                                                                           | JS は不要（`group-hover` だけ）だが hover 限定で、**キーボードとタッチで到達できない。** 5 枚に必要な場面が無い                                                                                                          |
| `input.tsx` `label.tsx` `form-field.tsx`                                                                | profile の編集フォームは**アイランドが DOM で組む**。この 3 つは class をコンポーネントの中に埋めていて、**JS からは文字列を取り出せない**（§3.1 の `button.tsx` との違い）。取り込んでも使えないので、§4.3 の定数で持つ |

### 3.5 使えない variant

| 使えないもの                                                      | 理由                                                                                                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`Badge variant="secondary"`**                                   | 上流が `border-subtle` と書いている。トークンは `--color-border-subtle` であって `--color-subtle` は無いので、**Tailwind がこのユーティリティを生成しない。** 枠線が消える |
| **`SidebarItemBadge`**                                            | 中で `<Badge variant="secondary">` を指定している。上と同じものを踏む                                                                                                      |
| `variant="success"` / `"warning"` / `"info"`（`Alert` / `Badge`） | トークンが無彩色。**既定と同じ見た目になる**（§1.4）                                                                                                                       |

`border-subtle` が生成されていないことは、いまの `kiwa.css` の出力で確かめられる
（`badge.tsx` は `@source` に入っていて、同じファイルの `border-primary/20` は
生成されている）。**`kiwa-stylesheet.test.ts` は画面が実際に吐いた class しか見ない**ので、
この variant を使う画面が出るまでは緑のままである。

**上流のファイルは直さないこと。** `README.md` が「上流から取り直したときに diff が
出ないようにしておく」と書いている。呼び出し側で別の variant を選ぶ。

---

## 4. アイランド —— 22 箇所のクラス名

### 4.1 どの画面に効くか

`account-island.ts` の 3 つの機能が、5 枚のうち 4 枚に掛かる。
**home には掛からない**（`HomePage` は `scripts` を渡していない）。

| 機能                 | 掛かる画面                   | 取っ掛かり                                                             | クラスを書いている行                                                                                                                                         |
| -------------------- | ---------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **取り消し**         | passkeys / sessions / grants | `li[data-session-id]` `li[data-passkey-id]` `li[data-grant-client-id]` | 119 `item-error` / 137 `empty` / 148 `button button-secondary button-small button-danger` / 190 `item-actions`                                               |
| **パスキー登録**     | passkeys                     | `[data-passkey-register]`                                              | 252 `item-main` / 254 `item-title` / 257 `item-meta` / 269 `list` / 278 `button button-secondary` / 282 `item-meta` / 285 `item-error` / 296 `item-meta`     |
| **プロフィール編集** | profile                      | `[data-profile-edit]`                                                  | 381 `field` / 397 `panel` / 399 `panel-header` / 401 `panel-title` / 404 `panel-desc` / 409 `panel-body` / 423 `button` / 427 `item-meta` / 430 `item-error` |

**プロフィール編集がいちばん重い。** パネル 1 枚を丸ごと DOM で組んでいるので、
`Card` / `CardHeader` / `CardTitle` / `CardDescription` / `CardContent` の中身を
JS 側にもう一度書くことになる。

### 4.2 先に直すのはセレクタ —— クラスで DOM を引いている

**クラス名は見た目のためだけに使われているのではない。** アイランドは
**サーバーが描いた HTML をクラスで引いている。**

| 行  | 引いているもの                                   | 一致しなくなると                                                     |
| --- | ------------------------------------------------ | -------------------------------------------------------------------- |
| 117 | `item.querySelector(".item-error")`              | 既存の文言を見つけられず、**エラーが行に増え続ける**                 |
| 122 | `item.querySelector(".item-main")?.append(node)` | `?.` が効いて**何も起きない。エラーが表示されない**                  |
| 152 | `item.querySelector(".item-title")?.textContent` | `aria-label` が「この項目 を削除」に落ちる。**読み上げだけが壊れる** |
| 248 | `document.querySelector("p.empty")`              | 0 件からの登録で**一覧が作られない**                                 |

**4 つとも例外を投げない。** 型検査もテストも何も言わず、画面も落ちない。
**初版はこれを「クラス文字列の重複」として書いていたが、重複より先にこちらが問題**である。

**直し方: `data-*` へ寄せる。** `ui-pages.test.ts` が P0 で同じ判断をしている
（「`panel-title` を見ていたときは、画面を Kiwa へ移しただけでここが落ちた。
`data-slot` は上流が構造を表すために置いている属性で、スタイルシートが変わっても
付いてくる」）。アイランドも同じ理由で同じ向きへ動かす。

| いま          | 移行後              |
| ------------- | ------------------- |
| `.item-error` | `[data-item-error]` |
| `.item-main`  | `[data-item-main]`  |
| `.item-title` | `[data-item-title]` |
| `p.empty`     | `[data-list-empty]` |

**`data-slot` を借りないこと。** あれは上流が自分の構造に付けている属性で、
`[data-slot="card-content"]` で引くと**上流の内部構造に依存する**。
取り直したときに黙って外れる。こちら側の目印は自分で付ける。

### 4.3 クラス文字列を定数にする

セレクタを直したうえで、**残る重複（サーバーと島の両方が同じ見た目を作る）を定数に寄せる。**

**置き場所: `apps/dashboard-worker/src/presentation/http/ui/ui-classes.ts`**（新規）。
`kiwa.css` の `@source "./"` がこのディレクトリを再帰で見ているので、
**走査対象には自動で入る**（`client/` も同じ理由で既に入っている）。

```ts
// 一覧の行（list / item-*）
export const LIST_CLASS = "flex flex-col";
export const LIST_ROW_CLASS = "flex items-start justify-between gap-5";
export const ITEM_MAIN_CLASS = "min-w-0";
export const ITEM_TITLE_CLASS = "font-medium break-all";
export const ITEM_META_CLASS = "text-sm/relaxed text-foreground-muted";
export const ITEM_RAW_CLASS = "font-mono text-xs break-all text-foreground-soft";
export const ITEM_ACTIONS_CLASS = "shrink-0";
export const ITEM_ERROR_CLASS = "text-sm text-destructive";

// 0 件（§4.5 でどちらに決めるかが変わる）
export const LIST_EMPTY_CLASS = "py-6 text-center text-sm text-foreground-soft";

// プロフィール編集のフォーム（Kiwa の input/label は JS から使えない。§3.4）
export const FIELD_CLASS = "flex flex-col gap-2";
export const FIELD_LABEL_CLASS = "text-sm font-medium text-foreground-muted";
export const FIELD_INPUT_CLASS =
  "w-full rounded-lg border border-input bg-card px-3 py-1 h-9 text-sm outline-none " +
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20";

// 島が引く目印（サーバーと島で 1 箇所にする）
export const ITEM_MAIN_ATTR = "data-item-main";
export const ITEM_TITLE_ATTR = "data-item-title";
export const ITEM_ERROR_ATTR = "data-item-error";
export const LIST_EMPTY_ATTR = "data-list-empty";
```

ボタンは `button.tsx` を取り込めば（§3.1）定数を書かずに済む。

```ts
import { getButtonClasses } from "@u18/web-ui/kiwa";

export const REVOKE_BUTTON_CLASS = getButtonClasses("outline", "sm") + " text-destructive";
export const PRIMARY_BUTTON_CLASS = getButtonClasses();
export const SECONDARY_BUTTON_CLASS = getButtonClasses("outline");
```

**ただし `cn` を島へ持ち込む代償を見ておくこと。** `getButtonClasses` は `cn`
（`clsx` + `tailwind-merge`）を呼ぶ。`cn` だけを esbuild で畳むと **27.8 KB**
になり、**いまの島が 18.4 KiB** なので**2 倍以上に太る。**

| 案                                                                                           | 島の大きさ | 上流との同期                               |
| -------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------ |
| A: 島が `getButtonClasses` を import                                                         | +27.8 KB   | 自動で追従する                             |
| B: 定数を素の文字列リテラルで書く                                                            | ±0         | **手で合わせる。上流が変わると気づけない** |
| C: サーバー側（`ui-classes.ts`）だけが `getButtonClasses` を呼び、**結果の文字列を島へ渡す** | ±0         | 自動で追従する                             |

**C を推す。** 島が読む `<li>` や mount 要素に `data-button-class="…"` として
載せれば、`cn` はサーバー側（Worker）でだけ走る。
**`tailwind-merge` がブラウザへ行く理由はどこにも無い** —— 島が作るクラスは
重複も上書きも無く、必要なのは「決まった文字列」だけである。

### 4.4 テストが見ていない範囲

`kiwa-stylesheet.test.ts` の「class が 1 つ残らず CSS にある」は、
**サーバーが吐いた HTML の `class="…"` しか見ない**（`classesIn(html)`）。
**島が実行時に付けるクラスは 1 つも見ていない。**

つまり §4.3 の定数に綴りの間違いがあっても、**CSS の無い class が本番の
ブラウザにだけ出る。** これは #320 と同じ形である。

**対策の案:** `ui-classes.ts` が export する文字列を**テストから直接読んで**
同じ照合に掛ける。画面を描く必要が無く、島を実行する必要も無い。

```
const used = Object.values(await import("…/ui-classes")).flatMap((v) => v.split(/\s+/));
```

**`@source` の走査と、この照合は別の話である。** 走査は「CSS が生成されるか」、
照合は「生成されたか確かめたか」。走査に入っていても綴りを間違えれば生成されない。

### 4.5 0 件の表示が 2 つに割れる

**`/account/apps` の前例は「0 件なら `Card` を描かず `Empty` を出す」**（§1.3）。
これを passkeys / sessions / grants にそのまま当てると、**島と食い違う。**

島の `removeItem`（137 行）は、最後の 1 件を消したときこうしている。

```
list.replaceWith(empty);   // <ul> を <p class="empty"> に差し替える
```

差し替えているのは `CardContent` の**中の `<ul>`** である。サーバー側の 0 件が
「`Card` ごと無い `Empty`」だとすると、

> **最後の 1 件を取り消した直後と、そのあと再読み込みした後で、画面が違う。**

**判断が要る。**

| 案    | 中身                                                                                                                                 | 代償                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| A     | 島が `Card` ごと `Empty` の DOM に差し替える                                                                                         | 島が `Empty` / `EmptyHeader` / `EmptyTitle` / `EmptyDescription` の class を**もう一度持つ**。§4.3 の定数が 4 つ増える |
| **B** | **一覧の 0 件は `Card` の中に置く**（1 行の中央寄せテキスト）。`Empty` は `/account/apps` のような**ページ全体が空**のときだけに使う | `/account/apps` と見た目が割れる                                                                                       |

**B を推す。** 2 つは**違う状態**である。`/account/apps` の空は「u18 がまだ
アプリを載せていない」で、利用者には何もできない。passkeys / sessions / grants の
空は「**あなたが全部消した**」で、直前まで中身があった場所である。
**`Card` ごと消えると、操作した場所そのものが画面から消える。**

B なら島は `list.replaceWith(p)` のまま、`p.className = LIST_EMPTY_CLASS` を
差し替えるだけで済む。

---

## 5. 退役の順序

### 5.1 5 枚 + `message-page` が終わった時点で消せるもの（36 個）

```
dash  dash-side  dash-main  dash-inner  page-head
side-brand  side-group  side-group-label  side-links  side-link
stack  cards  cards-3
panel  panel-header  panel-title  panel-desc  panel-body  panel-footer
stat  stat-value  stat-label
list  item-main  item-title  item-meta  item-raw  item-actions  item-error
facts  section-lead  empty  badge  badge-warn  button-small
body.page-dash と @media (max-width: 52rem) のダッシュボード分
```

消す**前に**片付けるもの:

- **`DashboardShell` と `Layout` の `frame="dash"`**（使う側がいなくなる）
- **`dashboard-shell.tsx` が再 export している `DashboardNavKey`**。
  実体は `dashboard-nav.ts` にあるので、import 元を付け替える
- **`account-island.ts` の 22 箇所**（§4）。**ここを直さずにクラスだけ消すと、
  JS が描いた部分だけ素の HTML になる。** サーバー側のテストは緑のままで、
  `kiwa-stylesheet.test.ts` も島を見ていない（§4.4）

### 5.2 消えないもの —— auth-worker が握っている 17 個

5 枚を全部移しても、**`styles.ts` は空にならない。** ログイン画面・同意画面が
同じ `UI_STYLESHEET` を読んでいる（定義は 1 つ、配信は Worker ごと）。

| 分類     | 残るもの                                                                                  | 使っている auth の画面                   |
| -------- | ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| 骨格     | `.card` `.brand` `body`（中央寄せ） `h2` `*` `::selection`                                | `Layout` の `frame="card"` を使う 4 箇所 |
| ボタン   | `.button` `.button-secondary` `.button-danger` `.link-button`                             | login / consent                          |
| フォーム | `.field` `.code-input` `input[type="email"]` `input[type="text"]`                         | login                                    |
| 文字     | `.lead` `.notice` `.links` `.error`                                                       | login / consent                          |
| 構造     | `.identity` `.scopes` `.separator` `.inline-form`                                         | login / consent                          |
| focus    | `input:focus-visible, .button:focus-visible, .link-button:focus-visible, a:focus-visible` | 全部                                     |
| トークン | `:root` の全変数                                                                          | 全部                                     |

**`.scopes` には注意が要る。** grants（移す側）と consent（残る側）の**両方**が使う。
grants を Kiwa へ移しても `.scopes` は消えない。

### 5.3 NFC が絡むもの

`cards-page.tsx` が `.lead` `.identity` `.scopes` `.notice` を使っているが、
**4 つとも auth-worker も使っている。** NFC（別セッション担当）が移っても
`styles.ts` からは 1 つも消えない。**退役の計画に NFC を数えないこと。**

### 5.4 `styles.ts` が消える条件

**P2（auth-worker のログイン / 登録 / 同意）が終わったときだけ。**
そのとき同時に消えるもの:

- `packages/web-ui/src/styles.ts`（`UI_STYLESHEET`）
- `Layout` の `frame`（`"card"` / `"shell"` / `"dash"` が全部いなくなり、`"bare"` だけが残る）
- 各 Worker の `STYLESHEET_ROUTE` / `STYLESHEET_PATH` と、それを配る route
- `ui-pages.test.ts` の `EXPECTED_STYLESHEET`（全部が同じ 1 本になる）

なお **`.nav` `.section` `.badge-muted` は今でも誰も使っていない**。
`frame="shell"` も呼び出しが無く、`.shell` `.page-shell` に到達経路が無い。
`.passkey`（`login-island.tsx`）は使われているのに定義が無い。
**移行とは独立に消せるが、移行と混ぜないこと**（レビューが読めなくなる）。

---

## 6. 1 枚ずつ移すときに通る検査

### 6.1 `ui-pages.test.ts` の `EXPECTED_STYLESHEET`

**1 枚移すたびにこの表の 1 行を書き換える。**

```
[OVERVIEW_PATH, STYLESHEET_PATH,      ".dash-side"]   -> [OVERVIEW_PATH, KIWA_STYLESHEET_PATH, "tailwindcss"]
```

この describe が見ているのは 3 つ。

1. `EXPECTED_STYLESHEET` が `PAGES` を漏れなく覆っていること（**書き忘れ防止**）
2. 読む `<link rel="stylesheet">` が**ちょうど 1 本**であること（**混ぜない**）
3. その先が 200 で、`sentinel` を含むこと（**取り違え防止**）

**「両方読み込む」は 2 で塞がれている。** 1 枚ずつ移すときの一番楽な逃げ道が、
意図的に通らないようにしてある。

**足すべき行が 1 つある（§2.2）。** いまの表は Cookie 付きでしか取りに行かない。
**401（`SignInRequiredPage`）と 503（`UnavailablePage`）も同じ 1 本になること**を
見る行を足すこと。

### 6.2 `kiwa-stylesheet.test.ts`

`/account/apps` だけを見ているので、**移した画面を 1 つずつ足す。**
`it.each` に変えて `EXPECTED_STYLESHEET` の Kiwa 側から引くのが素直
（**画面を足して書き忘れる**形を 6.1 と同じ仕掛けで塞げる）。

島のクラスは見ていない（§4.4）。

### 6.3 見た目の class をテストの目印にしない

`ui-pages.test.ts` が P0 で踏んだ形がコメントに残っている。

> `panel-title` を見ていたときは、画面を Kiwa へ移しただけでここが落ちた。
> 落ちたのは正しいが、**直し先が「次のスタイルシートの class 名」になる**

5 枚を移すときも同じことが起きる。**`data-slot` か、中身の文字列（`>…</p>`）で見る。**

---

## 7. 初版（P0 前）からの差

| 初版                                                  | 本版                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 「`registry/ui` の 54 個から何を取るか」              | **取り込み済みの 6 個が前提。** 足すのは `button.tsx` 1 つ（§3.1）                      |
| 「`Card` に枠線を足すか決めてほしい」                 | **決着。** `--shadow-sm` がリングで輪郭を出す（§1.2）                                   |
| 「素の要素セレクタが Tailwind のレイヤーに勝つ」      | **回避済み。** 1 枚 1 本に分けた（§1.2 / §6.1）                                         |
| 「`.list` は `divide-y` で」                          | **`Separator` + `index > 0`** に変更（`/account/apps` の前例に揃える。§1.3）            |
| 「`.badge` は `variant="outline-primary"` で」        | **既定の `<Badge>`** に変更（同上）                                                     |
| 「0 件は `Empty` か 1 行かを P0 が決める」            | **一覧の 0 件は 1 行（案 B）を推す。** 島の `removeItem` と食い違うため（§4.5）         |
| 「Tailwind の `@source` に `client/**` を含めること」 | **済み。** `@source "./"` が `ui/` を再帰で見ている                                     |
| 「島のクラス文字列を定数にする」                      | **順番が逆。** 先に**セレクタ**を `data-*` へ移す。クラスの重複より壊れ方が悪い（§4.2） |
| 対象に NFC を含めていた                               | **NFC は別セッション担当。** 本書は 5 枚 + `message-page` に絞った                      |
