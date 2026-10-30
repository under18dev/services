# Kiwa UI 移行 —— 棚卸しと対応表

- Status: 設計（実装前）
- Date: 2026-10-30
- 追跡 issue: [#332](https://github.com/under18dev/services/issues/332)（移行本体） / [#338](https://github.com/under18dev/services/issues/338)（NFC）
- 対象: `packages/web-ui/src/styles.ts` の手書き CSS を読んでいる全画面

本書は「いま何を使っていて、それを Kiwa の何に置き換えるか」だけを書く。
Tailwind v4 のビルド経路・`registry/ui` の取り込み方・`@theme` へのトークン移植は
**#332 の P0 の担当範囲**なので、ここでは決めない。P0 が決めた import の形に合わせて
本書の「置き換え先」を読み替えること。

調査時点の Kiwa: `kiwa-ui/kiwa-ui` の `registry/ui`（54 ファイル）と `registry/lib`（2 ファイル）。
MIT のこの 2 つだけを見ている。Pro のブロック（sidebar layouts / page headers / data tables /
settings pages）は対象外。

---

## 0. 先に結論

1. **パネル・ボタン・バッジ・フォームは Kiwa にそのままある。** `.panel*` → `Card*`、
   `.button*` → `Button`、`.badge*` → `Badge`、`.field` → `FormField` + `Input`。
2. **骨格（`.dash` / `.stack` / `.cards` / `.page-head`）は無い。** 組み上がったレイアウトは
   Pro 側にある。MIT で手に入るのは部品だけなので、骨格は Tailwind のユーティリティで組む。
3. **一覧（`.list` / `.item-*` / `.facts` / `.scopes`）に対応する primitive も無い。**
   `Table` はあるが、この 4 つはどれも 0 件になりうる一覧なので表には向かない（§3）。
4. **Kiwa の primitive のうち 5 つは CSP で使えない**（インライン `style=` を出す）。
   #332 が候補に挙げている `sidebar-collapsible` がそこに含まれる（§5）。
5. **auth-worker が移るまで、手書き CSS は 1 行も消せない。** スタイルシートは
   `UI_STYLESHEET` という 1 つの定数で、auth / dashboard / nfc が同じものを配っている（§4）。

---

## 1. 移行対象の棚卸し

### 1.1 画面と、いま使っているクラス

`class="..."` の literal と、アイランドが実行時に書く `className = "..."` の両方を数えた。

| Worker    | ファイル                         | 使っているクラス                                                                                                                                                                                                  |
| --------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web-ui    | `packages/web-ui/src/layout.tsx` | `brand` `card` `shell` `page-shell` `page-dash`                                                                                                                                                                   |
| dashboard | `ui/dashboard-shell.tsx`         | `dash` `dash-side` `dash-main` `dash-inner` `page-head` `side-brand` `side-group` `side-group-label` `side-links` `side-link` `notice`                                                                            |
| dashboard | `ui/home-page.tsx`               | `stack` `cards` `cards-3` `panel` `panel-header` `panel-title` `panel-desc` `panel-body` `stat` `stat-value` `stat-label` `list` `item-main` `item-title` `item-meta` `button` `button-secondary` `button-small`  |
| dashboard | `ui/profile-page.tsx`            | `panel` `panel-body` `facts` `badge` `badge-warn` `notice`                                                                                                                                                        |
| dashboard | `ui/passkeys-page.tsx`           | `panel` `panel-body` `panel-footer` `list` `item-main` `item-title` `item-meta` `empty`                                                                                                                           |
| dashboard | `ui/sessions-page.tsx`           | `panel` `panel-body` `section-lead` `list` `item-main` `item-title` `item-meta` `item-raw` `badge` `empty`                                                                                                        |
| dashboard | `ui/grants-page.tsx`             | `panel` `panel-body` `list` `item-main` `item-title` `item-meta` `scopes` `empty`                                                                                                                                 |
| dashboard | `ui/message-page.tsx`            | `panel` `panel-body` `section-lead` `links`                                                                                                                                                                       |
| dashboard | `ui/apps-page.tsx`               | `stack` `panel` `panel-header` `panel-title` `panel-desc` `panel-body` `list` `item-main` `item-title` `item-meta` `item-raw` `badge` `empty` `notice`                                                            |
| dashboard | `ui/client/account-island.ts`    | `panel` `panel-header` `panel-title` `panel-desc` `panel-body` `list` `item-main` `item-title` `item-meta` `item-actions` `item-error` `empty` `field` `button` `button-secondary` `button-small` `button-danger` |
| nfc       | `ui/cards-page.tsx`              | `lead` `identity` `scopes` `notice`                                                                                                                                                                               |
| auth      | `ui/login-page.tsx`              | `lead` `field` `code-input` `error` `identity` `button` `button-secondary` `button-danger` `link-button` `links` `inline-form` `separator` `notice`                                                               |
| auth      | `ui/consent-page.tsx`            | `lead` `identity` `scopes` `error` `button` `button-secondary` `notice`                                                                                                                                           |
| auth      | `ui/client/login-island.tsx`     | `button` `button-secondary` `notice` `passkey`                                                                                                                                                                    |

`apps-page.tsx` は **#332 の P0 の見本ページ**なので、本書の対応表は使われず P0 の実装が正になる。
ここには棚卸しの完全性のためだけに載せている。

### 1.2 クラス別に見た使用元

`styles.ts` で定義しているクラスを、使っている Worker で引いたもの。
**移行の順番はこの表で決まる** —— auth の列が付いているものは dashboard を移しても消せない。

| クラス                                                                             | auth | dashboard  | nfc | web-ui |
| ---------------------------------------------------------------------------------- | :--: | :--------: | :-: | :----: |
| `brand` `card` `shell` `page-shell` `page-dash`                                    |      |            |     |   ○    |
| `button` `button-secondary` `button-danger`                                        |  ○   |     ○      |     |        |
| `field`                                                                            |  ○   | ○ (island) |     |        |
| `links`                                                                            |  ○   |     ○      |     |        |
| `notice`                                                                           |  ○   |     ○      |  ○  |        |
| `scopes`                                                                           |  ○   |     ○      |  ○  |        |
| `identity`                                                                         |  ○   |            |  ○  |        |
| `lead`                                                                             |  ○   |            |  ○  |        |
| `error` `code-input` `separator` `inline-form` `link-button`                       |  ○   |            |     |        |
| `dash` `dash-side` `dash-main` `dash-inner` `page-head`                            |      |     ○      |     |        |
| `side-brand` `side-group` `side-group-label` `side-links` `side-link`              |      |     ○      |     |        |
| `stack` `cards` `cards-3`                                                          |      |     ○      |     |        |
| `panel` `panel-header` `panel-title` `panel-desc` `panel-body` `panel-footer`      |      |     ○      |     |        |
| `stat` `stat-value` `stat-label`                                                   |      |     ○      |     |        |
| `list` `item-main` `item-title` `item-meta` `item-raw` `item-actions` `item-error` |      |     ○      |     |        |
| `facts` `section-lead` `empty` `badge` `badge-warn` `button-small`                 |      |     ○      |     |        |

### 1.3 棚卸しで出た不整合

移行とは独立に直せるもの。**移行と混ぜないこと**（レビューが読めなくなる）。

| 種別                         | 対象                     | 状況                                                                                    |
| ---------------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| 定義があるのに使われていない | `.nav`                   | `account-shell.tsx` が `dashboard-shell.tsx` に置き換わった時点で用済み                 |
| 同上                         | `.section`               | `.panel` に置き換わった。`.section-lead` だけが生き残っている                           |
| 同上                         | `.badge-muted`           | 定義だけある                                                                            |
| 到達経路が無い               | `.shell` / `.page-shell` | `Layout` の `frame="shell"` を渡している呼び出しが 1 つも無い                           |
| 使われているのに定義が無い   | `.passkey`               | `login-island.tsx` が `<div class="passkey">` を出すが `styles.ts` に `.passkey` は無い |

### 1.4 アイランドが実行時にクラス名を書いている

`apps/dashboard-worker/src/presentation/http/ui/client/account-island.ts` は、
22 箇所で `node.className = "..."` と**文字列リテラルを直接代入している**。

```
account-island.ts:148   button.className = "button button-secondary button-small button-danger";
account-island.ts:397   panel.className = "panel";
```

これは移行で 2 つの問題になる。

1. **Tailwind の content 検出に `client/**/*.ts` を含めないと、島が使うユーティリティが
   出力から落ちる。** 画面は正しいのに、JS が描いた部分だけ素の HTML になる。
2. **島の中で `cn()` は使いにくい。** `clsx` + `tailwind-merge` を島のバンドルへ同梱する
   ことになる。

推奨: **クラス文字列をサーバー側のコンポーネントと共有する定数として export し、
島はそれを import する。** そうすれば文字列は静的に 1 箇所へ集まり、content 検出にも
素直に載る。島の中で `cn()` を呼ぶ必要も消える（組み合わせは定数側で済ませる）。

---

## 2. 対応表 —— 既存クラス → Kiwa primitive

「置き換え先」の列は、`registry/ui` の**ファイル名と export 名**で書いている。
import のパス（`@/components/ui/...` のままか、`@u18/web-ui` 配下に寄せるか）は P0 が決める。

### 2.1 そのまま置き換わるもの

| 既存クラス                      | 置き換え先                                                     | 備考                                                                                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.panel`                        | `card.tsx` `Card`                                              | **`Card` は枠線を持たない**（`bg-card` + `shadow-sm`）。`.panel` は `1px solid var(--border)` なので、`class="border border-border"` を足すか、`@theme` 側で影ではなく枠線で段差を作ると決めるか、P0 で揃える      |
| `.panel-header`                 | `CardHeader`                                                   | 下線は `class="border-b"`。`CardHeader` は `[.border-b]:pb-6` を持っていて、**下線を引いたときの余白まで面倒を見る作りになっている**                                                                               |
| `.panel-title`                  | `CardTitle`                                                    | `<h3>` を出す。見出し階層を変えたくない箇所では `as` が無いので要注意（§3）                                                                                                                                        |
| `.panel-desc`                   | `CardDescription`                                              |                                                                                                                                                                                                                    |
| `.panel-body`                   | `CardContent`                                                  |                                                                                                                                                                                                                    |
| `.panel-footer`                 | `CardFooter`                                                   | 上線は `class="border-t"`（`[.border-t]:pt-6`）                                                                                                                                                                    |
| `.button`                       | `button.tsx` `Button`                                          | 幅 100% は `class="w-full"`。`.button` は既定で全幅だが Kiwa は `inline-flex`                                                                                                                                      |
| `.button-secondary`             | `Button variant="outline"`                                     | `.button-secondary` は透明背景 + `--border` 枠。`outline` が一致する（`secondary` は塗りが入る）                                                                                                                   |
| `.button-danger`                | `Button variant="destructive"`                                 | ただし `destructive` は**塗り**。`.button-danger` は文字色と枠線だけなので、design.md の "No colorful UI." に寄せるなら `variant="outline" class="text-destructive border-destructive/35 hover:bg-destructive/10"` |
| `.button-small`                 | `Button size="sm"`                                             |                                                                                                                                                                                                                    |
| `.link-button`                  | `Button variant="link-muted"`                                  | `<button>` のまま。`.link-button` と同じく muted → hover で foreground                                                                                                                                             |
| `.badge`                        | `badge.tsx` `Badge variant="outline-primary"`                  | `.badge` は塗らずに文字色だけアクセント。`variant="default"` は `bg-primary-soft` で**塗る**ので使わない                                                                                                           |
| `.badge-warn`                   | `Badge variant="outline-destructive"`                          | 同上。`destructive` / `destructive-soft` は塗る                                                                                                                                                                    |
| `.error`                        | `alert.tsx` `Alert variant="destructive"` + `AlertDescription` | `role="alert"` は `Alert` が自分で付ける。既存の `<p class="error" role="alert">` から重複を外す                                                                                                                   |
| `.field`                        | `form-field.tsx` `FormField` + `input.tsx` `Input`             | `FormField` が label / description / error をまとめて持つ。`<label><span>…</span><input></label>` から `id` 紐づけへ変わる                                                                                         |
| `.side-link`                    | `sidebar-item.tsx` `SidebarItem`                               | `active` prop がある。**`aria-current="page"` は自分で渡すこと** —— `SidebarItem` が出すのは `data-active` だけで、支援技術には届かない                                                                            |
| `.side-group-label`             | `sidebar-menu-button.tsx` `SidebarMenuSectionLabel`            |                                                                                                                                                                                                                    |
| `.separator`（`<hr>` 的な用途） | `separator.tsx` `Separator`                                    | ただし auth の `.separator` は**中央に文字が入る**形なので対象外（§3）                                                                                                                                             |
| `.inline-form`                  | ユーティリティ `inline`                                        |                                                                                                                                                                                                                    |

### 2.2 ユーティリティで書くもの（primitive が要らない）

| 既存クラス              | 置き換え                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `.stack`                | `grid gap-5`                                                                                                       |
| `.cards`                | `grid gap-5`                                                                                                       |
| `.cards-3`              | `grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]`                                                                   |
| `.lead` `.section-lead` | `text-sm text-foreground-muted`                                                                                    |
| `.notice`               | `mt-3 text-sm text-foreground-muted`（§3 も読むこと）                                                              |
| `.links`                | `mt-6 text-sm`                                                                                                     |
| `.item-main`            | `min-w-0`                                                                                                          |
| `.item-title`           | `font-medium [overflow-wrap:anywhere]`                                                                             |
| `.item-meta`            | `mt-1 text-[0.8125rem] text-foreground-soft [overflow-wrap:anywhere]`                                              |
| `.item-raw`             | `mt-0.5 font-mono text-xs leading-normal text-foreground-muted [overflow-wrap:anywhere]`                           |
| `.item-actions`         | `shrink-0`                                                                                                         |
| `.item-error`           | `mt-1.5 text-[0.8125rem] text-destructive`                                                                         |
| `.side-brand`           | `block mb-7 px-2.5 text-xs font-medium uppercase tracking-[0.12em] text-foreground-soft no-underline`              |
| `.side-group`           | `mb-6`                                                                                                             |
| `.side-links`           | `flex flex-col gap-0.5`（`<ul>` のまま）                                                                           |
| `.page-head`            | `mb-8` + `<h1 class="text-2xl font-semibold tracking-tight">` + `<p class="mt-1.5 text-sm text-foreground-muted">` |
| `.code-input`           | `Input class="text-center font-mono text-xl tracking-[0.4em]"`                                                     |
| `.brand`                | `mb-8 text-xs font-medium uppercase tracking-[0.12em] text-foreground-soft`                                        |

`overflow-wrap: anywhere` に対応するユーティリティは Tailwind v4 に無い（`break-words` は
`overflow-wrap: break-word`）。上の表は arbitrary property で書いている。**長い User-Agent や
client_id が横にはみ出す画面なので、`break-words` で代用しないこと。**

### 2.3 Kiwa の MIT 側に無く、ユーティリティで組む骨格

| 既存クラス                          | 組み方                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.dash`                             | `grid grid-cols-[15rem_minmax(0,1fr)] min-h-dvh`、狭い画面は `max-[52rem]:grid-cols-[minmax(0,1fr)]`                                                                                        |
| `.dash-side`                        | `border-r border-border bg-background-subtle px-4 py-6`。幅の定数は `sidebar-menu-button.tsx` が `dashboardSidebarWidthClasses` として export しているので、`w-64` を直書きせずそちらを使う |
| `.dash-main`                        | `min-w-0 px-10 pt-10 pb-20`                                                                                                                                                                 |
| `.dash-inner`                       | `w-full max-w-[46rem]`                                                                                                                                                                      |
| `.card`（Layout の `frame="card"`） | `Card class="w-full max-w-md p-10"`                                                                                                                                                         |

`sidebar-menu-button.tsx` は `dashboardTopChromeClasses` / `dashboardSidebarWidthClasses` を
export している。**ダッシュボードの寸法を揃えるための定数が MIT 側にも置いてある**ので、
レイアウトを手で組む場合もここから取ること。Pro を買わずに寸法だけ揃えられる。

---

## 3. 置き換えられないもの

**ここに挙げたものに `styles.ts` のクラスを足して対応しないこと。**
手書きデザインを止めるのが今回の発端なので、足した瞬間に移行の意味が消える。
既存 primitive の組み合わせかユーティリティで組む。

### 3.1 一覧（`.list` / `.item-*`）—— 対応する primitive が無い

Kiwa には `Table` があるが、`.list` の用途（パスキー・セッション・連携アプリ・カタログ）は
**どれも 0 件になりうる**。`sessions-page.tsx` のコメントが「項目数が 0 件になりうるので
表より素直になる」と書いているとおり、ヘッダ行だけが残る表は読みづらい。

**案: `<ul>` を保ち、行の中身を `Card` の兄弟として組む。**

```
<ul class="divide-y divide-border">
  <li class="flex items-start justify-between gap-5 py-4 first:pt-0 last:pb-0">
    <div class="min-w-0">…</div>
    <div class="shrink-0">…</div>
  </li>
</ul>
```

`divide-y` で `.list > li { border-top }` の形がそのまま出る。
`first:pt-0 last:pb-0` が `.list > li:first-child` / `:last-child` に対応する。

**行を `Card` にしない。** `Card` は `bg-card` を持つので、`CardContent` の中に
並べると面が二重になって境界が読めなくなる。

### 3.2 `.facts`（プロフィールの定義リスト）—— 無い

`<dl>` に当たる primitive は `registry/ui` に無い。`Table` で組むと
「表示名 / ユーザー名 / メール / 登録日」の 4 行に `<thead>` が要らない表ができる。

**案: `<dl>` のままユーティリティで組む。**
`divide-y divide-border` + `<div class="flex gap-5 py-3">` +
`<dt class="w-30 shrink-0 text-sm text-foreground-muted">` + `<dd class="m-0 min-w-0">`。

### 3.3 `.scopes`（同意画面と連携アプリの scope 一覧）—— 無い

箇条書きの primitive は無い。`.scopes` は 2 つの文脈で見た目が違う
（単独 = `padding-left: 1.25rem`、`.list` の中 = 詰めて `--muted-deep`）。
**この「文脈で変わる」部分は CSS の子孫セレクタでやっていたので、移行先では
呼び出し側が明示的にクラスを分ける必要がある。**

**案:** 単独は `<ul class="mb-7 pl-5 text-foreground-muted [&>li]:mb-2">`、
行内は `<ul class="mt-1.5 pl-5 text-[0.8125rem] text-foreground-soft [&>li]:mb-0.5">`。

### 3.4 `.stat`（ホームの数値タイル）—— 無い

数値タイル（KPI）は Pro 側。MIT には `DisplayCard` があるが、これは
title / description を持つ汎用の箱で、「数を大きく、意味を小さく」の形は持っていない。

**案: `Card` + `<a>` を 1 枚ずつ。** リンク全体が押せる形（`.stat` は `<a>` そのもの）を保つ。

```
<Card class="border border-border p-0">
  <a href={…} class="block px-6 py-5 no-underline text-inherit hover:bg-secondary">
    <span class="block text-[1.75rem] font-semibold tracking-tight">{value}</span>
    <span class="mt-0.5 block text-[0.8125rem] text-foreground-muted">{label}</span>
  </a>
</Card>
```

**`DisplayCard variant="primary"` は使わない** —— `bg-primary-mesh` が入る（§5）。

### 3.5 `.separator`（auth の「または」）—— `Separator` では足りない

Kiwa の `Separator` は 1px の棒を 1 本出すだけで、**中央に文字を置く口が無い**。
`.separator` は `::before` / `::after` で左右に線を伸ばして間に文字を挟んでいる。

**案: `Separator` を 2 つ並べる。**
`<div class="my-7 flex items-center gap-3 text-xs text-foreground-soft">` の中に
`<Separator class="flex-1" />` / テキスト / `<Separator class="flex-1" />`。
擬似要素が消えるので、文字がテキストノードとして読める利点もある。

### 3.6 `.identity`（「誰として操作しているか」の枠）—— 一致する primitive が無い

`sidebar-menu-button.tsx` の `SidebarMenuDropdownProfile` が形としては近いが、
**`Avatar` を必ず出す**のでアバターを持たないこの画面には重い。

**案: `Card class="mb-6 border border-border p-3.5"` + `<strong class="block font-medium">` +
`<span class="text-sm text-foreground-muted">`。**

**nfc の `cards-page.tsx` は `.identity` を「1 件を枠で囲む」目的で借りている。**
こちらは意味が違う（本来は本人確認の表示）ので、`Card` へ移すときに
**借り物をやめてカード 1 枚 = `Card` 1 枚にする**こと。

### 3.7 `.empty`（0 件の表示）—— `Empty` はあるが重さが違う

Kiwa の `Empty` は `rounded-2xl border border-dashed p-6 md:p-12` の**大きな空状態の箱**。
既存の `.empty` は `CardContent` の中に出る 1 行の中央寄せテキスト。
そのまま差し替えると、パネルの中に破線の箱が入れ子になる。

**案は 2 つ。P0 の見本（`/account/apps`）がどちらを採ったかに揃えること。**

- **A: パネルをやめて `Empty` を出す。** 0 件のときだけ `Card` を描かず
  `Empty` + `EmptyHeader` + `EmptyTitle` + `EmptyDescription` を出す。Kiwa の意図に沿う
- **B: 1 行のまま。** `<p class="py-6 text-center text-sm text-foreground-soft">`

ただし **B を採ると、アイランドが「最後の 1 件を消したあと」に作る空表示（`account-island.ts:137`）
も B で書くことになる。** A を採るなら島側も `Empty` の DOM を組む必要があり、島が太る。
**この一点だけで B を推す。**

### 3.8 `.notice`（補足テキスト）—— `Alert` は強すぎる場合がある

`.notice` は 2 つの用途で使われている。

- **`<noscript>` の中の「JS が無いとできないこと」の説明**（`dashboard-shell.tsx`）
  → `Alert variant="default"` + `AlertDescription` が合う。注意を引くべき内容である
- **同意画面・NFC の末尾の補足**（「このアプリを知らない場合は…」）
  → 箱にすると注意が過剰になる。`text-sm text-foreground-muted` のユーティリティで足りる

**1 つのクラスが 2 つの役割を持っていたので、移行時に 2 つへ割れる。** 同じ置き換えにしない。

### 3.9 `.page-head` / `.dash*` —— §2.3 のとおり MIT 側に無い

組み上がった page header / sidebar layout は Pro。#332 が「ダッシュボードを組むのに必要な
ものは無料側にある」と書いているのは部品のことで、**骨格は自分で組む**という理解で正しい。

---

## 4. 退役できないクラス

### 4.1 なぜ消せないのか

`styles.ts` は `UI_STYLESHEET` という**定数 1 つ**で、auth-worker が `/ui/u18.css`、
dashboard-worker が `/account/ui/u18.css`、nfc-worker も自分の経路で、
**同じ中身を各自が配っている**（`styles.ts` の「定義はここ 1 つ。配信は Worker ごとに行う」）。

したがって **dashboard だけ Kiwa にしても、消せるのは「dashboard しか使っていないクラス」だけ**。
#332 の段取りで言えば、**P2（auth-worker）が終わるまで `styles.ts` は空にならない。**

### 4.2 P1（dashboard の 5 ページ）が終わった時点で消せるもの

`.dash` `.dash-side` `.dash-main` `.dash-inner` `.page-head`
`.side-brand` `.side-group` `.side-group-label` `.side-links` `.side-link`
`.stack` `.cards` `.cards-3`
`.panel` `.panel-header` `.panel-title` `.panel-desc` `.panel-body` `.panel-footer`
`.stat` `.stat-value` `.stat-label`
`.list` `.item-main` `.item-title` `.item-meta` `.item-raw` `.item-actions` `.item-error`
`.facts` `.section-lead` `.empty` `.badge` `.badge-warn` `.button-small`
`body.page-dash` と `@media (max-width: 52rem)` のダッシュボード分

**ただし `.empty` と `.button*` は `account-island.ts` も使っている**（§1.4）。
**島を直さずにクラスだけ消すと、JS で描かれた部分だけが素の HTML になる。**
サーバー側のテストは緑のままなので、**この壊れ方は CI で拾えない。**

### 4.3 NFC（#338 Step 2）が終わっても消えないもの

nfc は `.lead` `.identity` `.scopes` `.notice` の 4 つを使っているが、
**4 つとも auth-worker も使っている。** NFC を移しても 1 つも消せない。

加えて、nfc は `Layout` の既定（`frame="card"`）を使っているので
`.card` と `.brand` も間接的に使っている。`DashboardShell` へ移せば（#338 Step 2）
この 2 つの利用者は auth だけになるが、**auth が 3 箇所で使っているので消えない。**

### 4.4 最後まで残るもの（auth-worker が移るまで）

| 分類     | 残るもの                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 骨格     | `body`（中央寄せ） `.card` `.brand` `h2` `*{box-sizing}` `::selection`                                                            |
| トークン | `:root` の全変数（`--bg` `--card` `--border` `--fg` `--muted` `--accent` `--danger` `--radius` `--font-sans` `--font-mono` ほか） |
| フォーム | `input[type="email"]` `input[type="text"]` の素の要素セレクタ、`.field` `.code-input`                                             |
| ボタン   | `.button` `.button-secondary` `.button-danger` `.link-button`                                                                     |
| 文字     | `.lead` `.notice` `.links` `.error`                                                                                               |
| 構造     | `.identity` `.scopes` `.separator` `.inline-form`                                                                                 |
| focus    | `input:focus-visible, .button:focus-visible, .link-button:focus-visible, a:focus-visible`                                         |

### 4.5 これが P0 に跳ね返る —— 素の要素セレクタとカスケードレイヤー

**`UI_STYLESHEET` は要素セレクタを持っている。**

```
body { display: flex; align-items: center; justify-content: center; padding: 2rem 1.5rem; … }
h2 { margin: 0 0 0.5rem; font-size: 1.5rem; font-weight: 600; … }
input[type="email"], input[type="text"] { width: 100%; padding: 0.7rem 0.85rem; … }
* { box-sizing: border-box; }
```

Tailwind v4 は出力全体を `@layer theme, base, components, utilities` に入れる。
**CSS のカスケードでは、レイヤーに属さない規則がすべてのレイヤーより強い。**
つまり、この手書きシートを Tailwind の出力と素朴に結合すると、
**`h2 { font-size: 1.5rem }` が `CardTitle` の `text-*` ユーティリティに勝つ。**
`input[type="text"]` も同様に `Input` の `px-3 py-1 rounded-lg` を上書きする。

**症状が出るのは「Kiwa に移したページ」のほうで、原因は「まだ移していない auth 用の規則」にある。**
移行の途中でしか起きず、しかも原因と症状の置き場所が違うので、追いにくい部類の壊れ方になる。

**対応（P0 の判断事項として #332 へ渡す）:**

- `UI_STYLESHEET` を `@layer legacy { … }` で包み、Tailwind より前に `@layer legacy, theme, base, components, utilities;` と順序を宣言する。**クラスを足すのではなく既存の全体をレイヤーに入れるだけ**なので、手書きデザインを増やすことにはならない
- もしくは、配信を Worker ごとに分け、Kiwa に移したページには手書きシートを配らない。ただし `styles.ts` が「定義を 2 つに分けないこと」と明記しているので、**この方向を採るなら先にその判断を覆す必要がある**

---

## 5. 使ってはいけない Kiwa primitive

### 5.1 CSP 違反 —— インライン `style=` を出す（5 ファイル）

画面には `style-src 'self'` が掛かっている。`style-src-attr` を別に指定していないので、
CSP3 の規定で `style` 属性は `style-src` に落ち、**ブラウザが属性ごと捨てる**。
`styles.ts` のコメントが書いている「本番で枠線が密着していた」のと同じ経路である。

| ファイル                   | 出す内容                                 | 捨てられたときの症状                                                                        |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `sidebar-collapsible.tsx`  | `style="max-height: 0px"`                | `hidden` も一緒に付いているので**中身が出ない**。開く JS も動かないとナビ項目が丸ごと消える |
| `progress.tsx`             | `style={{ transform: … }}`               | 進捗バーが常に 0%                                                                           |
| `slider.tsx`               | `style={{ … }}` (2 箇所)                 | つまみの位置が出ない                                                                        |
| `placeholder-gradient.tsx` | `style={…background-image…}`             | 何も描かれない                                                                              |
| `blog-post-card.tsx`       | `style="background: linear-gradient(…)"` | 装飾が出ない                                                                                |

**`sidebar-collapsible` は #332 が候補に挙げているが、このままでは使えない。**
サイドバーを折りたたむ必要が出たら、`<details>` / `<summary>` で組むこと
（JS 無しで開閉でき、インライン `style=` も要らない）。

### 5.2 design.md 違反 —— グラデーション

- `placeholder-gradient.tsx`（コンポーネント全体が目的からして違反）
- `blog-post-card.tsx`（`linear-gradient`）
- `display-card.tsx` の `variant="primary"`（`bg-primary-mesh`）

**"No gradients." / "No rainbow effects." / "No colorful UI." は継続。**
`DisplayCard` を使う場合は `variant="default"` 固定にする。

### 5.3 JS が無いと中身が消えるもの

「JS 無しで使えること」は #332 / #338 の両方が守るものに挙げている。
下の 3 つは **JS が落ちると中身が見えなくなる**ので、
**情報を載せる場所には使えない**（付加的な操作にだけ使う）。

| ファイル                                                                        | 無効時の状態                                                                |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `tabs.tsx`                                                                      | `TabsContent` に `hidden` が付いたまま。**全タブの中身が消える**            |
| `dialog.tsx`                                                                    | `open` でない限り `hidden`。トリガーが押せないボタンになる（#306 と同じ形） |
| `accordion.tsx` `collapsible.tsx` `dropdown-menu.tsx` `popover.tsx` `sheet.tsx` | 同様に開かない                                                              |

**`tooltip.tsx` は JS 不要**（`group-hover/tooltip:block` の CSS だけで動く）。
ただし hover でしか出ないので、**キーボードとタッチで到達できない。**
消えて困らない補足にだけ使うこと。

### 5.4 `cn` を使う以上、`tailwind-merge` が実行時に載る

`registry/lib/utils.ts` は `clsx` + `tailwind-merge`。
**サーバー側（Worker）では問題にならないが、アイランドへ持ち込むとバンドルが太る。**
§1.4 の「クラス文字列を定数として共有する」案は、ここにも効く。

---

## 6. 進め方の提案

#332 の段取りを、本書の棚卸しで補ったもの。

| 段   | 対象                                                           | 本書で見る節                                                               |
| ---- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| P0   | 基盤 + `/account/apps`（**別セッション担当**）                 | §4.5（レイヤー） §3.7（`Empty` の A/B 決め） §2.1（`Card` の枠線を決める） |
| P1-a | **nfc `cards-page.tsx`**（#338 Step 2 / 運用者が最優先と指示） | §3.1 §3.6 §3.3                                                             |
| P1-b | dashboard の残り 5 ページ + `DashboardShell`                   | §2.3 §3.1 §3.4                                                             |
| P1-c | `account-island.ts` のクラス文字列                             | §1.4 §4.2                                                                  |
| P2   | auth-worker（ログイン / 登録 / 同意）                          | §4.4 —— **ここが終わって初めて `styles.ts` が消える**                      |

**P0 が §3.7 と §2.1 をどう決めたかで、P1 以降のすべてのページが変わる。**
`/account/apps` が出てきたら、まずその 2 点を読むこと。

### NFC を組むときの追加の制約（#338）

- **遷移先 URL を `<a href>` にしない。** `cards-page.tsx` のコメントのとおり、
  利用者が自由に入れた外部 URL なので、一覧を開いただけで飛べると**この画面が踏み台になる**。
  `Table` や `Card` に移しても、`targetUrl` は**文字列のまま**出す
- **書き込みは JSON API 1 本。** form POST を並べない。操作 UI はアイランドから
  既存の `cards.routes.ts` を叩く（#338 Step 1 のアイランド基盤が前提）
- 「このページからは行えません」の案内（`.notice`）は、操作が付いた時点で消す
