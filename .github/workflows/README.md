# Workflows

このディレクトリの GitHub Actions ワークフローについての規約。

## Action はコミット SHA で固定する

`uses:` で参照する外部 Action は、**すべて 40 桁のコミット SHA で固定する**。`@v4` のような可変タグは使わない。

```yaml
# OK
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0

# NG
- uses: actions/checkout@v4
```

末尾にバージョンをコメントで残す。Dependabot はこのコメントも併せて更新する。

### なぜ

`v4` のようなタグは後から別のコミットへ付け替えられる。つまり「CI で実際に実行されるコード」はこちらで固定されていない。上流アカウントの侵害やタグの書き換えが起きると、こちらが何も変更していないのに次の実行から別のコードが走る。

このリポジトリでは特に重く効く。`deploy.yml` の各ジョブは `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を環境変数として渡しており、**同じジョブ内で動く任意のステップがこれを読める**。このトークンは Identity Provider の Worker をデプロイでき、D1 マイグレーションを適用できる。CI のサプライチェーンがそのまま本番認証基盤への経路になっている。

`pnpm/action-setup` は GitHub 公式ではないサードパーティ Action なので、ここは特に効く。

なお `actions/dependency-review-action@v4` の `v4` は**タグですらなくブランチ**だった。ブランチは push のたびに動くので、可変タグよりさらに弱い参照になる。

### 例外

リポジトリ内のローカル参照（`./.github/actions/...`）は固定しない。同一コミットの内容が使われるため、外部からの差し替えが起きない。

### 更新

`.github/dependabot.yml` に `github-actions` エコシステムを設定してあるので、固定したままでも Dependabot が週次で更新 PR を出す。手動メンテにはならない。

新しい Action を足すときは、次でタグを SHA に解決してから書く。

```sh
gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq '.object.sha'
```

アノテーテッドタグの場合は、もう一段たどる必要がある。

```sh
gh api repos/<owner>/<repo>/git/tags/<上で得た sha> --jq '.object.sha'
```

## チェック一覧の 1 行を信じない

**2026-10-29 に 3 種類の誤読が起きた。** どれも `gh pr checks` の出力だけを見て
判断したもので、**検査そのものは正しく動いていた。** 集約して 1 行にする過程で
意味が変わる。

| 見え方                            | 実態                                                                                                                                                 | 見分け方                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **赤**                            | **古い木を見ている。** `pull_request` のチェックは `refs/pull/N/merge` を見るので、base が進むと再計算が要る                                         | **再実行では直らない。** `gh pr update-branch <N>` で追従させる                                                                |
| **チェックが 1 つも無い**         | **run が 1 本も作られていない。** 原因は 2 つ —— (a) コンフリクト（`mergeStateStatus` が `DIRTY`）、(b) **`MERGEABLE` なのに作られていない**（下記） | `no checks reported` は「CI 未設定」と**区別が付かない。** `gh pr view <N> --json mergeable,mergeStateStatus` の**両方**を見る |
| **赤（ジョブは全部緑）**          | **古い run が追い越されて `cancelled` になり、集約ジョブだけが `failure` を残している**                                                              | `gh run view <id> --json jobs` で `cancelled` が並んでいないか見る                                                             |
| **同じ名前のチェックが 2 つ並ぶ** | **片方は解析ジョブ、片方は GitHub Advanced Security の集約。** 短いほう（数秒）が集約で、**そちらが alert を報告する**                               | URL の形で見分ける。`/actions/runs/<run>/job/<job>` は解析ジョブ、`/runs/<id>` は check-run（下記）                            |

3 つ目は**同じ PR に両方が並ぶ。** `#300`（マージ済み・全ジョブ緑）の実際の出力:

```
$ gh pr view 300 --json statusCheckRollup ...
CI FAILURE      <- 追い越された古い run
CI SUCCESS      <- 本番の run
Typecheck CANCELLED
Typecheck SUCCESS
...（全ジョブが二重）
```

**1 行だけを見ると、マージ済みで全ジョブ緑の PR を「赤い」と報告することになる。**

### CodeQL が赤いとき、どちらが赤いのかを見る

**`CodeQL` という名前のチェックは 2 つ出る。** #323 の実際の出力:

```
CodeQL  fail  5s      https://github.com/under18dev/services/runs/123555323780
CodeQL  pass  1m17s   https://github.com/under18dev/services/actions/runs/40904275498/job/123554635478
```

| URL の形                        | 実体                                                  | 何を言っているか                             |
| ------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| `/actions/runs/<run>/job/<job>` | 解析ジョブ                                            | **解析が走ったか**。コードの中身は見ていない |
| `/runs/<id>`                    | check-run（`app.slug` が `github-advanced-security`） | **この PR の差分に新しい alert があるか**    |

**赤いのは後者である。** 前者は 1 分以上かかって緑、後者は数秒で赤 ——
**短いほうが本物**という、表の他の行とは逆の見え方になる。

`gh run view <id>` は前者の ID しか受けない。後者を渡すと **404** になる
（**`gh` が壊れているのではない。** run と check-run は別の資源である）。

```bash
# 何件あるかと、何の alert かは check-run の output に出る
gh api repos/<owner>/<repo>/check-runs/<id> -q '.output.title, .output.summary'
#   1 new alert including 1 high severity security vulnerability
```

### alert の中身は `refs/pull/<N>/merge` を引く

**ブランチを引いても 0 件が返る。**

```bash
# これは空
gh api 'repos/<owner>/<repo>/code-scanning/alerts?ref=refs/heads/<branch>&state=open'

# これで出る
gh api 'repos/<owner>/<repo>/code-scanning/alerts?ref=refs/pull/<N>/merge&state=open' \
  -q '.[] | "\(.rule.id) (\(.rule.security_severity_level)) \(.most_recent_instance.location.path):\(.most_recent_instance.location.start_line)"'
#   js/polynomial-redos (high) packages/web-ui/src/asset-hash.ts:140
```

**`pull_request` の解析は `refs/pull/N/merge`（base と混ぜた木）を見る。**
ブランチの先端は解析されていないので、そちらに alert は紐づかない。
**「ブランチに alert が無い」を「問題が無い」と読まないこと。**

### `MERGEABLE` なのにチェックが 1 本も無いとき

**`DIRTY` ではないのに run が作られていないことがある。** #324 の実測:

```
mergeable=MERGEABLE  status=BLOCKED  base=main
gh run list --branch <branch>         → 0 件
gh api .../commits/<head>/check-runs  → total_count 0
```

ruleset が CI を要求しているので、**走っていないこと自体が `BLOCKED` の
理由**になる。待っても変わらない —— **作られていないものは完了しない。**

**再トリガは `gh pr update-branch` で足りる。**

```bash
gh pr update-branch <N>   # base を取り込んだ新しい head ができ、pull_request が走る
```

実測では、これで head が変わり `pull_request` の run が 2 本作られた。
**close → reopen でも再トリガできるが、そちらは PR の状態を一度壊す**
（通知が飛び、レビューの文脈が切れる）。**副作用の小さいほうを先に試すこと。**

原因は特定していない。force-push や base の削除と前後したときに起きて
いるように見えるが、**そう書くのは推測である。** 観測できるのは上の 3 つで、
対処はそれで足りる。

### 手元の検査は全部緑でありうる

#323 では `pnpm lint` / `pnpm typecheck` / `pnpm test` が**全部通っていた。**
CodeQL だけがローカルに無いので、**手元で全部緑でも CI で落ちる経路が
1 つ残っている。** 落ちたら上の手順で中身まで降りること —— 「CodeQL が
赤い」だけでは何も直せない。

**押す前に `mergeStateStatus` を見ること。** ただしこれにも 4 つ目の値がある。

| `mergeStateStatus` | 意味                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `CLEAN`            | 押せる                                                                            |
| `BLOCKED`          | 理由を run まで辿る                                                               |
| `DIRTY`            | コンフリクト。**何も走っていない**                                                |
| **`UNKNOWN`**      | **GitHub がマージ可能性を再計算している最中。押せるかどうかはまだ決まっていない** |

**`UNKNOWN` を「落ちている」とも「通る」とも読まない。** もう一度引けば大抵
変わる。変わらなければ base が動いていないかを見る。

**厄介なのは待てば解決することである。** 「よく分からないが押してみたら通った」
で済ませられるので、**次に見た人がまた同じ判断をする。** 2026-10-29 には 4 回出た。

うち 1 回は、`gh pr view` が**再計算の完了を待って 120 秒以上かかり、それでも
`UNKNOWN` を返した**（呼び出し側のタイムアウトを越えてバックグラウンドへ落ちた）。
**`gh` は落ちていない。** 粘ったうえで「まだ決まっていない」と答えている。

## 本文と head は鮮度が違う

**`mergeStateStatus` を見ても、これは防げない。** `CLEAN` でも起こる。

`gh pr view` は PR のタイトル・本文と head を**同じ画面に並べて**見せる。
ところがこの 2 つは変わり方が違う。

|                | 変わるとき                   | 誰が変えられるか |
| -------------- | ---------------------------- | ---------------- |
| タイトル・本文 | **いつでも**（`gh pr edit`） | 作成者           |
| head           | **push したときだけ**        | 作成者           |

**つまり「本文は新しいが head は古い」という状態が作れる。** そして
`gh pr view` はその食い違いを教えない —— 両方とも「現在の値」なので、
表示としては正しい。

### 2026-10-30 に起きたこと（#311）

作成者が検査の作り直しを push し、**タイトルと本文を差し替えてから**
マージを依頼した。押す側は `gh pr checks` が全部 pass なのを確認して押した。
入ったのは**差し替え前のコミット**だった。

```
入った:   73b3250  「自分で配っているか、隣から借りているか」
残った:   b1d9d3f  「各 Worker のジョブへ移し、借用を見る」
PR の表示: タイトルも本文も b1d9d3f のもの
```

**`gh pr view 311` を見ると入ったように読める。** 気づいたのは
`git grep -c probe_pages_for origin/main` を引いたときで、**PR の表示を
信じていたら分からなかった。**

このとき `mergeStateStatus` は `UNKNOWN` だったが、**それは原因ではない。**
差し替えの push と「押す」が前後しうること自体が原因なので、`CLEAN` を
見てから押しても同じことが起きる。

### 機械で閉じる

`gh pr merge` には **head を固定する引数がある。**

```bash
# **40 桁のフル SHA が要る。** 短縮形は受け付けない（下記）
full="$(gh pr view <N> --json headRefOid -q .headRefOid)"
gh pr merge <N> --squash --match-head-commit "$full"
```

`gh pr merge --help` より:

> `--match-head-commit SHA` Commit SHA that the pull request head must match to allow merge

**head が動いていれば押せない。** 「押す前に SHA を確かめる」を覚えておく
必要がなくなる。

### 実測した範囲（2026-10-30、#316 をこれで押した）

| 渡したもの                    | 結果                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| **短縮 SHA**（`31b209a`）     | **拒否。** `invalid value for expectedHeadOid (Could not coerce value "31b209a" to GitObjectID)` |
| フル SHA（head と一致）       | マージ成功                                                                                       |
| フル SHA（head と**不一致**） | **未実測**（下記）                                                                               |

**短縮形で黙って通らないのが重要である。** 通っていたら「固定したつもりで
固定できていない」状態が作れた。エラーに `expectedHeadOid` が出ることから、
この引数は GraphQL の `mergePullRequest` の同名フィールドへそのまま渡って
いると分かる —— **拒否はサーバー側で行われる**（`gh` の手元判定ではない）。

**不一致のときの拒否だけは、このリポジトリで確かめていない。** 確かめるには
わざと違う SHA で `gh pr merge` を呼ぶことになり、この環境ではマージ系の
コマンドが権限で止まる（**意図を区別できない以上、正しい挙動である**）。
`expectedHeadOid` の意味からすれば拒否されるはずだが、**そう書くのは推測
である。** 実測で裏が取れたらこの行を書き換えること。

**ただしこの拒否の挙動はこのリポジトリで実測していない。** 確かめるには
わざと違う SHA で `gh pr merge` を呼ぶことになり、この環境ではマージ系の
コマンドが権限で止まる（**意図を区別できない以上、正しい挙動である**）。
`--help` の記載を根拠にしている。**実測で裏が取れたらここを書き換えること。**

### 作る側の手順

**差し替えたら、どのコミットかを添える。** 「直しました」だけだと、押す側に
差し替え前後の区別が付かない。force-push したなら SHA を書く。

**片側だけでは閉じない。** 押す側が `--match-head-commit` を使っても、
作る側が SHA を伝えなければ「レビューしたときの SHA」が分からない。
逆に作る側が伝えても、押す側が素で押せば同じことが起きる。

## ワークフロー構成

| ファイル       | 契機                                   | 内容                                                                                                  |
| -------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ci.yml`       | PR / main への push                    | lint・prettier・typecheck・test・build。集約ジョブ `CI` をブランチ保護の required status check に使う |
| `deploy.yml`   | main への push（paths 絞り込み）・手動 | preflight → D1 マイグレーション → auth-worker → dashboard-worker の直列                               |
| `security.yml` | PR / main への push / 週次             | CodeQL・dependency review・pnpm audit                                                                 |

`deploy.yml` のデプロイ順は入れ替えないこと。dashboard-worker は auth-worker の `IdentityRPC` に Service Binding で依存するため、auth を先に出す（仕様書 4.4）。

## リポジトリ変数

`deploy.yml` のスモークテストは **Repository variables**（Settings → Secrets and variables → Actions → Variables）を読む。Secret ではないので値は公開情報でよい。

| 変数             | 用途                                                 | 例                         |
| ---------------- | ---------------------------------------------------- | -------------------------- |
| `PRODUCTION_URL` | auth-worker と dashboard-worker のスモークテスト先   | `https://auth.under18.dev` |
| `NFC_SHORT_URL`  | nfc-worker のスモークテスト先（短縮 URL のオリジン） | `https://go.under18.dev`   |

**未設定の間、該当するスモークテストは warning を出して skip する。** デプロイは止めない。ドメインが確定する前から deploy.yml を動かせるようにするためだが、裏を返すと**設定し忘れると検査が静かに無くなる**。本番を公開したら必ず両方を設定すること。

### なぜ 3 つで叩く先が違うのか

| Worker    | 叩く先                                             | 期待                                                            |
| --------- | -------------------------------------------------- | --------------------------------------------------------------- |
| auth      | `$PRODUCTION_URL/health`                           | 200 / `status=ok`・`checks.database=ok`・`checks.signingKey=ok` |
| auth      | `$PRODUCTION_URL/.well-known/openid-configuration` | 200 / `issuer=$PRODUCTION_URL`（`--env production` の付け忘れ） |
| auth      | `$PRODUCTION_URL/login` への form 送信             | JS 無しの経路が通ること（#226）                                 |
| auth      | 画面が参照するアセット                             | ハッシュ付き URL が 200・旧 URL が 404（#211）                  |
| auth      | `$PRODUCTION_URL/api/auth/passkeys/login/options`  | `rpId`・`userVerification`・`allowCredentials` 無し（#262）     |
| dashboard | `$PRODUCTION_URL/account/api/me`（Cookie 無し）    | 401 / `error=unauthenticated`・`Referrer-Policy=same-origin`    |
| nfc       | `$NFC_SHORT_URL/c/deploy_smoke_probe`              | 404 / `このカードは利用できません。`                            |

**dashboard と nfc に `/health` を使わないのは、叩けないからではない。** 3 つとも外から叩ける（実測、2026-10-29）:

```
auth.under18.dev/health          200  {"status":"ok","service":"u18-auth","checks":{...}}
auth.under18.dev/account/health  200  {"status":"ok","service":"u18-dashboard","checks":{"identity":"ok"},...}
go.under18.dev/health            200  {"status":"ok","service":"u18-nfc"}
```

理由は**見ている範囲**である。`/health` は依存先に触れずに答えると決めてあるので（どの Worker も同じ方針）、**その Worker が起動したことしか言わない。** `/account/api/me` は認証まで、`/c/*` はカードの解決（D1 の読み）まで通る。auth だけ `/health` を使っているのは、あちらが `checks.database` / `checks.signingKey` を自分で確かめているからである。

> **「どちらの `/health` も本番 route に当たらず外から叩けない（#97）」と書いてあった。** nfc の route は `go.under18.dev/c/*` ではなく `go.under18.dev/*` で、dashboard は `auth.under18.dev/account/*` に載っている。**どちらも届く。** 同じ主張が `deploy.yml` にもあり #282 / #283 で直したが、**ここが残っていた。** 結論（`/health` を使わない）は変わらず、理由が事実でなかった。

いずれもステータスだけでなく**本文を検証する**。ステータスだけだと「別の Worker が同じステータスを返している」を見逃す。route の割り当てを間違えたときにまさにそれが起きる。`/health` の本文は `service` で Worker を名乗るので、**取り違えは `/health` でも捕まえられる** —— 使わない理由は範囲であって、名乗らないことではない。

**`environment` は読んでいない。** かつて auth の `/health` から `environment=production` を読んで `--env production` の付け忘れを見ていたが、**未認証で叩ける endpoint に構成情報を置くのをやめた**（脅威モデル RR-18）。同じ付け忘れは Discovery の `issuer` で検出できる（付け忘れると `ISSUER` も既定値のまま乗る）うえ、`issuer` は OIDC が公開を必須にしているので公開面が増えない。

curl とリトライの実体は `scripts/smoke-probe.sh` にある。3 つの Worker が同じものを使う。複数箇所に写すと片方だけ直す事故が起きるため。
