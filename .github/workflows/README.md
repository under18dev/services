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
