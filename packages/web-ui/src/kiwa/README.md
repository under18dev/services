# Kiwa UI の取り込み（#332）

ここにあるのは [Kiwa UI](https://github.com/kiwa-ui/kiwa-ui) の
`registry/ui/` と `registry/lib/` を**このリポジトリへコピーしたもの**。
shadcn と同じ方式で、依存として抱え込まず**ソースを持つ**。

```
MIT License
Copyright (c) 2026 Tossell Web Solutions Limited
```

上流の `LICENSE` が MIT で覆っているのは次の範囲である。**`registry/blocks/pro/`
は別ライセンス（有償）なので、ここへ持ってこないこと。**

- `registry/ui/`（無料の UI primitives）
- `registry/lib/`（共有ヘルパー）
- `registry/blocks/free/`
- `@kiwa-ui/cli` / `@kiwa-ui/enhance`

## なぜ依存にせずコピーするのか

上流がそういう配り方をしている（`@kiwa-ui/cli add button card` が
**自分のリポジトリへソースを書き出す**）。npm の package として入れる口が
そもそも無い。

このリポジトリにとっては都合がよい側面もある。**コンポーネントが吐く HTML が
diff に出る。** CSP は `style-src 'self'` で、インライン `style=` は
ブラウザに捨てられる（#320）。配っている HTML が読めない形で入ってくると、
同じ事故に気づけない。

## 取り込んであるもの

| ファイル           | 上流                                                     |
| ------------------ | -------------------------------------------------------- |
| `utils.ts`         | `registry/lib/utils.ts`（`cn` だけ）                     |
| `alert.tsx`        | `registry/ui/alert.tsx`                                  |
| `badge.tsx`        | `registry/ui/badge.tsx`                                  |
| `card.tsx`         | `registry/ui/card.tsx`                                   |
| `empty.tsx`        | `registry/ui/empty.tsx`                                  |
| `separator.tsx`    | `registry/ui/separator.tsx`                              |
| `sidebar-item.tsx` | `registry/ui/sidebar-item.tsx`                           |
| `theme.css`        | `templates/styles/globals.css`（**値は入れ替えてある**） |

**`/account/apps` を組むのに要ったものだけ。** 残りの画面（#332 の P1 / P2）で
足りなければそのとき持ってくる。先に 50 個入れない —— 使っていない
コンポーネントは、Tailwind の走査対象に入るだけで誰も読まない。

## 足すときの手順

1. 上流の `registry/ui/<name>.tsx` を取る
   （`https://raw.githubusercontent.com/kiwa-ui/kiwa-ui/main/registry/ui/<name>.tsx`）
2. `@/lib/utils` -> `./utils`、`@/components/ui/<x>` -> `./<x>` に直す。
   **それ以外は変えない**
3. 冒頭に由来のコメントを置く（既存のファイルと同じ形）
4. `index.ts` に export を足す
5. 使っているトークンが `theme.css` に有ることを確かめる。
   **無いトークンのユーティリティは Tailwind が生成しない** ——
   class は HTML に出るのに CSS が無い、という #320 と同じ形になる

## 変えてあるところ

**`.prettierignore` に並んでいるのが「上流のまま」のファイルの一覧である。**
整形もしていないので、上流から取り直したときの diff が中身の違いだけになる。

### `theme.css`

色は design.md（`under18dev/under18dev`）の値で、Inter の外部読み込み・
ライトパレット・グラデーションは落としてある。理由はあのファイルの冒頭。

### `badge.tsx` —— `border-subtle` -> `border-border-subtle`（#338）

**1 語だけ直してある。** 上流の `border-subtle` は Tailwind の
ユーティリティとして存在せず（トークンは `--color-border-subtle`）、
そのままだと `variant="secondary"` のバッジから枠線が消える。
**class は HTML に出るのに CSS が無い**という、#320 と同じ形である。

`apps/nfc-worker/test/kiwa-stylesheet.test.ts` が実際にこれで落ちた。
**取り込んだ 6 つの class 文字列 207 個を端から端まで調べて、効いていない
ものはこれ 1 つだけだった。**

**上流から取り直すときは、この 1 語を当て直すこと。** 当て直さなくても
落ちるのは、その class を使うページがある場合だけである。

### それ以外

`*.tsx` は import の書き方以外に手を入れていない。見た目を変えたくなったら、
コンポーネントではなく `theme.css` か、呼び出し側の `class` で行うこと。

## 効いていない class を見つける

画面ごとの検査（`test/kiwa-stylesheet.test.ts`）は**描かれた class** しか
見ない。取り込んだコンポーネント全体を調べたいときは、class 文字列を
並べたファイルを `@source` の走査範囲（このディレクトリ）に置いて
`build-client.mjs` を回し、出てきた CSS と突き合わせる。`border-subtle`
はその方法で確かめた。
