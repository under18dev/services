# vendored: gdg-jp/design-system

u18 全体のデザインを GDG Apps のデザインシステムへ寄せる移行（PR1）で取り込んだもの。
運用者は GDG 側の人間であり、vendoring の許諾は確認済み。上流に `LICENSE` ファイルは
無いことも確認済み（運用者了承済み）。

## 由来

| 項目           | 値                                                       |
| -------------- | -------------------------------------------------------- |
| 上流リポジトリ | https://github.com/gdg-jp/design-system (public, `main`) |
| 取得コミット   | `e543157f4c94cf35a3269a51b0dfca3f0714f7d8`               |
| 取得日         | 2026-11-08                                               |
| 取得元パス     | `src/styles/tokens.css`, `src/styles/components.css`     |

## 無改変であること

`tokens.css` / `components.css` は**上記コミットから 1 バイトも変えずに**置いてある
（確認: `diff` が空）。ファイル本体の先頭にコメントを足していないのも同じ理由 ——
本体に手を入れると diff が効かなくなり、上流の更新を追えなくなる。調整したい点は
この README や `../kiwa/theme.css` 側の別ファイルで吸収する。

## 取り込んでいないもの

- **`tailwind.css` は取り込んでいない。** `--color-muted` が u18 側では「面」、GDG
  側では「文字色」という逆の意味を持つなど、トークン名の衝突が複数あり、両立しない
  （実測は issue 側の記録を参照）。**マッピングの正本は `../kiwa/theme.css` の
  `@theme inline` 側に置く**——右辺を `--gdg-*` に向ける形にしてあり、`tailwind.css`
  は要らない。
  - 副作用: `tailwind.css` が持つ `@custom-variant dark (&:where(.dark, .dark *));`
    も入らないため、**`dark:` バリアントのユーティリティは生えない**。今のところ
    どの画面も使っていないが、使いたくなったら利用側（`kiwa.css`）で自分で
    `@custom-variant` を足す必要がある。
- **`fonts.css` は取り込んでいない。** Google Sans の自前配信は別 PR（PR2）の範囲。
  このコミットの時点では `--gdg-font-sans` を `--font-sans` に当てていない
  （`../kiwa/theme.css` 参照）。

## 更新手順

1. 上記リポジトリの `main` から新しいコミットを取る。
2. `src/styles/tokens.css` と `src/styles/components.css` をそのままこのディレクトリへ
   上書きする（**整形し直さない、コメントを足さない**）。
3. 上の表の取得コミット・取得日を更新する。
4. `tokens.css` の `.dark { ... }` ブロックに変数が増減していないか確認する——
   増減していれば `pnpm --filter @u18/web-ui test` が
   `generate-gdg-dark-media` のテストで落ちる（`generated/dark-media.css` が
   古いままだと変数名の集合が一致しなくなるため）。落ちたら
   `node packages/web-ui/scripts/generate-gdg-dark-media.mjs` を実行して
   `generated/dark-media.css` を作り直し、コミットする。
5. `../kiwa/theme.css` の `@theme inline` / `:root` が参照している `--gdg-*` 変数名が
   すべてまだ存在するか確認する（名前が変わった・消えた場合はそこも直す）。
6. `pnpm --filter @u18/admin-worker preview:html` で 17 画面をライト・ダーク両方
   見て、見た目が壊れていないか確認する。
