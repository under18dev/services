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
