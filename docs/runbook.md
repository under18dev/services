# u18 Identity — 運用ランブック

- Status: Draft
- Version: 0.1.0
- Date: 2026-10-24
- 対象: `apps/auth-worker` / `apps/dashboard-worker`
- 前提仕様書: `docs/u18-identity-spec.md`

## 0. このドキュメントの読み方

本書は、コードを書いていない担当者が深夜に障害対応するために読む手順書である。各節は上から順に実行できる番号付き手順として書く。

**現状は Phase 1（仕様書 12）のスケルトンである。** 以下は未実装であり、手順を最後まで書けない箇所はその都度「Phase N で実装」と明記する。

| 機能                                                                         | 現状                                                      | 実装箇所                                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| `/health`、`/api/me`、`/api/me/sessions`（GET / DELETE）                     | 実装済み                                                  | `apps/auth-worker/src/presentation/http/`                      |
| `IdentityRPC`（getSession / getUserProfile / listSessions / revokeSession）  | 実装済み                                                  | `apps/auth-worker/src/presentation/rpc/identity.entrypoint.ts` |
| `/.well-known/openid-configuration`                                          | 静的に応答する                                            | `apps/auth-worker/src/presentation/http/oauth.routes.ts`       |
| JWKS、`/oauth/authorize`、`/oauth/token`、`/oauth/userinfo`、`/oauth/revoke` | **501 を返す**（Phase 2）                                 | 同上                                                           |
| メール OTP、Passkey、ログアウト                                              | **501 を返す**（Phase 1 の残り）                          | `apps/auth-worker/src/presentation/http/auth.routes.ts`        |
| `PATCH /api/me`                                                              | **501 を返す**                                            | `apps/auth-worker/src/presentation/http/me.routes.ts`          |
| マイグレーション SQL                                                         | **1 本も生成されていない**（`packages/db/drizzle/` は空） | `packages/db/src/schema/`                                      |

したがって、本番トラフィックを受けられる状態ではない。本書の「インシデント対応」は、現時点で実行可能な手段（DB への直接操作、Secret 差し替え、デプロイ巻き戻し）を中心に書いてある。

---

## 1. 環境と構成

### 1.1 Worker 構成

| 項目                | auth-worker                       | dashboard-worker                       |
| ------------------- | --------------------------------- | -------------------------------------- |
| パッケージ          | `@u18/auth-worker`                | `@u18/dashboard-worker`                |
| Worker 名           | `u18-auth`                        | `u18-dashboard`                        |
| 設定                | `apps/auth-worker/wrangler.jsonc` | `apps/dashboard-worker/wrangler.jsonc` |
| エントリ            | `apps/auth-worker/src/index.ts`   | `apps/dashboard-worker/src/index.ts`   |
| 公開入口            | OIDC HTTP + アカウント API        | 設定 UI / BFF API                      |
| 内部入口            | `IdentityRPC`（named export）     | なし                                   |
| D1                  | **所有者**（`IDENTITY_DB`）       | **持たない**                           |
| compatibility_date  | 2026-08-15                        | 2026-08-15                             |
| compatibility_flags | `nodejs_compat`                   | `nodejs_compat`                        |
| observability       | 有効                              | 有効                                   |

`compatibility_date` が仕様書の日付（2026-10-24）ではなく 2026-08-15 なのは意図的である。`@cloudflare/vitest-pool-workers` が同梱する workerd のビルド日より後の日付を指定すると、テスト起動時に `ERR_FUTURE_COMPATIBILITY_DATE` で落ちる。上げるときは `@cloudflare/vitest-pool-workers` / miniflare も同時に上げ、`pnpm test` が通ることを確認してからにする。

### 1.2 Binding

**auth-worker**

| Binding       | 種別 | 値                                                                 |
| ------------- | ---- | ------------------------------------------------------------------ |
| `IDENTITY_DB` | D1   | `database_name: u18-identity` / `database_id` は未設定（後述 1.5） |

`migrations_dir` は `../../packages/db/drizzle` を指す。auth-worker ディレクトリからの相対パスである。

**dashboard-worker**

| Binding    | 種別            | 値                                             |
| ---------- | --------------- | ---------------------------------------------- |
| `IDENTITY` | Service Binding | `service: u18-auth`, `entrypoint: IdentityRPC` |

### 1.3 絶対に守る規則 — D1 Binding は auth-worker だけ

仕様書 2.2「Identity の書き込み権限は auth-worker に集約する」に対応する運用規則。

1. `d1_databases` を `apps/dashboard-worker/wrangler.jsonc`（および将来の `nfc-worker`）に追加してはならない。
2. dashboard-worker が Identity のデータを必要とする場合、必ず `IDENTITY` Service Binding 越しの RPC を使う。`@u18/db` に依存してもいけない。
3. 新しい Worker を追加するレビューでは、`wrangler.jsonc` の `d1_databases` の有無を必ず確認する。確認コマンド:

   ```bash
   grep -rn "d1_databases" /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps
   ```

   `apps/auth-worker/wrangler.jsonc` 以外がヒットしたら、その変更はマージしない。

この規則が崩れると、auth-worker の UseCase に集約した認可チェック（所有者確認・停止ユーザーの遮断）を迂回して DB を読み書きできる経路が生まれる。

### 1.4 プレーン var と Secret の区別

**プレーン var**（`wrangler.jsonc` の `vars` に平文で入る。Git に載る。機密にしてはいけない）

| 名前              | Worker    | 現在値                  | 意味                                        |
| ----------------- | --------- | ----------------------- | ------------------------------------------- |
| `ISSUER`          | auth      | `http://localhost:8787` | OIDC Issuer。Discovery と Origin 検証に使う |
| `RP_ID`           | auth      | `localhost`             | WebAuthn の Relying Party ID                |
| `RP_NAME`         | auth      | `u18 Identity`          | WebAuthn の表示名                           |
| `WEBAUTHN_ORIGIN` | auth      | `http://localhost:8787` | WebAuthn の期待 Origin                      |
| `ENVIRONMENT`     | auth      | `development`           | 動作モード。後述の分岐を支配する            |
| `AUTH_ISSUER`     | dashboard | `http://localhost:8787` | auth-worker の公開 URL                      |
| `ENVIRONMENT`     | dashboard | `development`           | 動作モード                                  |

**Secret**（`wrangler secret put` で設定。`wrangler.jsonc` にも Git にも入れない。ローカルは `.dev.vars`）

雛形は `apps/auth-worker/.dev.vars.example` にある。`.dev.vars` は `.gitignore` 済み。

| Secret            | Worker | 用途                                                    | 漏洩時の影響範囲（blast radius）                                                                                                                                              |
| ----------------- | ------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIGNING_KEY_JWK` | auth   | ID Token 署名用 ES256 秘密鍵（JWK JSON）                | **最大**。任意の `sub` / `aud` を名乗る ID Token を偽造でき、u18 の全 RP に任意ユーザーとしてログインできる。RP 側は署名が通るので検出できない。§5.1 の緊急ローテーション対象 |
| `SIGNING_KEY_KID` | auth   | 上記鍵の kid                                            | 単体では機密でない（JWKS で公開される値）。ただし `SIGNING_KEY_JWK` と不一致になると全 ID Token が RP 側で検証不能になる                                                      |
| `IP_HASH_PEPPER`  | auth   | `sessions.ip_hash` / `audit_logs.ip_hash` を作る pepper | **中**。DB ダンプと併せて漏れると、IPv4 空間（約 43 億）は総当たり可能なので全ユーザーの接続元 IP が復元される。未成年ユーザーの位置情報に相当する（仕様書 9 Privacy）        |
| `EMAIL_API_KEY`   | auth   | メール送信プロバイダのキー                              | **中**。u18 のドメインから任意の宛先へメールを送れる。u18 を騙るフィッシングに直結する。**現時点ではどのコードもこの値を読んでいない**（プロバイダ未選定 / 仕様書 14-3）      |

### 1.5 `ENVIRONMENT` が支配する分岐 — 本番デプロイ前に必ず読む

`ENVIRONMENT` は単なるラベルではなく、4 箇所の挙動を切り替える。うち 2 つは安全装置であり、設定を誤ると無言で外れる。

1. **メール送信**（`apps/auth-worker/src/composition/container.ts`）
   `development` のときだけ `ConsoleEmailSender` を使う。これは OTP を Workers のログへ平文で出力する。`development` 以外では `throwUnconfigured()` が投げられ、コンテナ生成が失敗する → **全リクエストが 500 になる**。これは「本番で OTP がログに流れる」より安全側に倒した意図的な設計である（仕様書 14-3 の決着待ち）。
2. **`IP_HASH_PEPPER` の未設定チェック**（同ファイル）
   `development` では未設定なら `"dev-pepper"` にフォールバックする。`development` 以外では `IP_HASH_PEPPER is not set outside development` を投げてコンテナ生成が失敗する。つまり **pepper を設定せずに本番を名乗ると、全リクエストが 500 になる**。静かに既知の pepper へ落ちて匿名化が無言で壊れるより、起動を止める方を選んである。
3. **セッション Cookie**（`packages/contracts/src/session-cookie.ts` の `sessionCookieName()`）
   `development` では `u18_session`（`Secure` なし）、それ以外では `__Host-u18_session`（`Secure` 付き）になる。この名前は auth-worker と dashboard-worker が **契約パッケージ経由で共有**しており、どちらか片方だけが別名を見ることはない。
4. **ヘルス応答**：`/health` のボディに `environment` をそのまま出す。

#### 危険 — `wrangler.jsonc` に production 環境が定義されていない

現状、両 Worker とも `env.production` セクションを持たない。このまま `wrangler deploy` を実行すると、`vars` の `ENVIRONMENT: "development"` と `ISSUER: "http://localhost:8787"` がそのまま本番 Worker に乗る。結果:

- メール未設定と `IP_HASH_PEPPER` 未設定のハードフェイルがどちらも働かない。`ConsoleEmailSender` が本番で動き（OTP が Workers のログに残る）、IP ハッシュは公開された既定 pepper `"dev-pepper"` で計算される。
- Cookie が `__Host-` 接頭辞も `Secure` も付かない状態で発行される。
- Discovery が `http://localhost:8787` を Issuer として広告する。

**つまり `ENVIRONMENT` の設定ミスは、2 つの安全装置を同時に無効化する。** 逆に言えば、`ENVIRONMENT` を正しく設定した瞬間に、メールプロバイダと pepper の両方が揃っていなければ Worker は全リクエストで 500 を返す。本番初回デプロイ時にこの 500 を見たら、まずログで `EMAIL_PROVIDER is not configured` / `IP_HASH_PEPPER is not set` を確認する。

**本番デプロイの前に、`wrangler.jsonc` に `env.production` を追加して `ENVIRONMENT`・`ISSUER`・`RP_ID`・`WEBAUTHN_ORIGIN` を上書きし、`wrangler deploy --env production` を使う運用へ切り替えること。** 本ドキュメントはこの環境分離が未導入であることを前提に書いており、`--env` 付きの手順はあえて書いていない。仕様書 14-1（本番 Issuer ドメイン）の決着とセットで対応する。

なお `wrangler deploy` は `--keep-vars` を付けない限り、Cloudflare ダッシュボードで手動設定した var を毎回削除して `wrangler.jsonc` の内容で置き換える。var をダッシュボードで運用してはならない。Secret は `wrangler deploy` では消えない。

---

## 2. 初回セットアップ

前提: Node.js 22 以上、pnpm 12.15.0、Cloudflare Workers Paid アカウント。以降のコマンドのリポジトリルートは
`/Users/tanahiro2010/Documents/proj/teams/under18dev/services` とする。

### 2.1 依存関係のインストールと疎通確認

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services
pnpm install
pnpm typecheck
npx wrangler whoami
```

`wrangler whoami` が未ログインなら `npx wrangler login` を実行する。CI では `CLOUDFLARE_API_TOKEN` 環境変数を使う。

### 2.2 D1 データベースの作成

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 create u18-identity
```

出力に `database_id` が UUID で表示される。

### 2.3 `database_id` の埋め込み

`apps/auth-worker/wrangler.jsonc` の以下の行を編集する。

```jsonc
"database_id": "REPLACE_WITH_D1_DATABASE_ID",
```

`REPLACE_WITH_D1_DATABASE_ID` を 2.2 で得た UUID に置き換える。`database_id` は機密ではないのでコミットしてよい。

確認:

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services
grep -n "database_id" apps/auth-worker/wrangler.jsonc
npx wrangler d1 info u18-identity
```

`REPLACE_WITH_` が残っていると、`wrangler dev` も `wrangler deploy` も binding 解決の段階で失敗する。

### 2.4 Secret の生成と設定

#### 2.4.1 ES256 署名鍵（`SIGNING_KEY_JWK` / `SIGNING_KEY_KID`）

独自の鍵生成コードを書かない（仕様書 5.4）。Node.js の `node:crypto` で P-256 鍵ペアを作り、JWK として書き出す。

```bash
node -e '
const { generateKeyPairSync } = require("node:crypto");
const kid = `u18-${new Date().toISOString().slice(0, 10)}-1`;
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const meta = { alg: "ES256", use: "sig", kid };
console.log("SIGNING_KEY_KID=" + kid);
console.log("SIGNING_KEY_JWK=" + JSON.stringify({ ...privateKey.export({ format: "jwk" }), ...meta }));
console.log("PUBLIC_JWK=" + JSON.stringify({ ...publicKey.export({ format: "jwk" }), ...meta }));
'
```

出力例:

```text
SIGNING_KEY_KID=u18-2026-10-24-1
SIGNING_KEY_JWK={"kty":"EC","x":"...","y":"...","crv":"P-256","d":"...","alg":"ES256","use":"sig","kid":"u18-2026-10-24-1"}
PUBLIC_JWK={"kty":"EC","x":"...","y":"...","crv":"P-256","alg":"ES256","use":"sig","kid":"u18-2026-10-24-1"}
```

注意点:

- `d` を含む方が秘密鍵である。`PUBLIC_JWK`（`d` を含まない方）は `signing_key_metadata.public_jwk` に入れる値であり、機密ではない。
- 3 つの出力を取り違えないこと。`SIGNING_KEY_JWK` に公開鍵を入れると署名時に落ちる。`public_jwk` に秘密鍵を入れると **JWKS 経由で秘密鍵を世界中に配布する**ことになる。
- この出力は端末のスクロールバッファとシェル履歴に残る。設定後に `history -c`（zsh なら `fc -p`）と画面クリアを行い、スクリーンショットも残さない。

設定:

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler secret put SIGNING_KEY_JWK   # 対話プロンプトに JWK JSON を貼り付ける
npx wrangler secret put SIGNING_KEY_KID
```

#### 2.4.2 `IP_HASH_PEPPER`

環境ごとに別の値を使う（`apps/auth-worker/src/infrastructure/crypto/web-crypto.ts` の `PepperedIpHasher` のコメント参照）。

```bash
openssl rand -base64 32
```

あるいは:

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
```

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler secret put IP_HASH_PEPPER
```

**未設定時の挙動**: `container.ts` は `ENVIRONMENT=development` のときだけ既知の固定値 `"dev-pepper"` へフォールバックし、それ以外では `IP_HASH_PEPPER is not set outside development` を投げてコンテナ生成を失敗させる（= 全リクエストが 500）。したがって本番で設定を忘れると、IP 匿名化が静かに壊れるのではなく、サービスが明確に落ちる。安全側の挙動だが、**初回デプロイ前に必ず設定しておくこと。** §1.5 のとおり `ENVIRONMENT` が `development` のままだとこのチェックも働かない。

**pepper を変更すると、既存の `ip_hash` は新しい hash と照合できなくなる。** 現在の実装には pepper の世代管理がないため、ローテーションは「過去の ip_hash を事実上無効化する」操作になる。§7.3 の未決事項を参照。

#### 2.4.3 `EMAIL_API_KEY`

プロバイダ未選定（仕様書 14-3）。**現時点ではどのコードもこの値を読まないため、設定しても何も起きない。** プロバイダ決定後、`apps/auth-worker/src/infrastructure/email/` に実装を追加し、`container.ts` の `throwUnconfigured` 分岐を差し替えたうえで設定する。

```bash
# プロバイダ選定後に実行する
npx wrangler secret put EMAIL_API_KEY
```

#### 2.4.4 設定済み Secret の確認

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler secret list
```

値は表示されない。名前の一覧だけを確認する。`SIGNING_KEY_JWK`・`SIGNING_KEY_KID`・`IP_HASH_PEPPER` の 3 つが揃っていること。

#### 2.4.5 ローカル開発用

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
cp .dev.vars.example .dev.vars
# .dev.vars を編集し、2.4.1 / 2.4.2 で生成した「開発用の別の値」を入れる
```

`.dev.vars` は `.gitignore` 済み（`!.dev.vars.example` の例外付き）。本番の値をここに書かない。

### 2.5 マイグレーションの生成と適用

**現状 `packages/db/drizzle/` は空である。** スキーマ定義（`packages/db/src/schema/*.ts`）は揃っているが、SQL は 1 本も生成されていない。初回セットアップでは必ず生成から始める。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services
pnpm db:generate
```

`packages/db/drizzle/0000_*.sql` と `packages/db/drizzle/meta/` が作られる。生成された SQL を必ず目視し、`CREATE TABLE` が `users` / `user_emails` / `passkeys` / `webauthn_challenges` / `email_challenges` / `sessions` / `oauth_clients` / `oauth_redirect_uris` / `oauth_authorization_codes` / `oauth_grants` / `oauth_tokens` / `signing_key_metadata` / `audit_logs` の 13 テーブル分あることを確認してからコミットする。

ローカル適用:

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services
pnpm db:migrate:local
```

リモート適用:

```bash
pnpm db:migrate:remote
```

確認:

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 migrations list u18-identity --remote
npx wrangler d1 execute u18-identity --remote \
  --command "select name from sqlite_master where type='table' order by name;"
```

### 2.6 ローカル起動と確認

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services
pnpm dev            # auth-worker を http://localhost:8787 で起動
```

別端末で:

```bash
curl -s http://localhost:8787/health | jq
curl -s http://localhost:8787/.well-known/openid-configuration | jq
```

`/health` が `{"status":"ok", "checks":{"database":"ok"}, ...}` を返せばセットアップ完了。`checks.database` が `unreachable` なら 2.3 または 2.5 に戻る。

dashboard-worker を同時に動かす場合は `pnpm dev:dashboard` を別端末で実行する。Service Binding はローカルでも解決されるが、auth-worker 側が起動していないと RPC が失敗する。

### 2.7 デプロイ

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler deploy
cd ../dashboard-worker
npx wrangler deploy
```

初回は必ず auth-worker を先にデプロイする。dashboard-worker の `services` binding が参照する `u18-auth` が存在しないとデプロイが失敗する。

デプロイ前に 1.5 の警告（`ENVIRONMENT=development` が本番に乗る件）を読むこと。

---

## 3. 日常運用

### 3.1 マイグレーション

#### 3.1.1 なぜ生成と適用で場所が分かれているのか

- **生成は `packages/db`**。`packages/db/drizzle.config.ts` は `out: "./drizzle"` を指し、`schema: "./src/schema/index.ts"` から差分 SQL を書き出す。このコンフィグは **D1 の認証情報を一切持たない**（ファイル内コメント参照）。つまり drizzle-kit から本番 DB へ接続する経路が存在しない。SQL を書き出すだけの純粋なビルド工程である。
- **適用は `apps/auth-worker`**。`apps/auth-worker/wrangler.jsonc` の `migrations_dir: "../../packages/db/drizzle"` によって、wrangler が同じディレクトリを読む。適用の権限は wrangler の認証（= デプロイ経路）に閉じている。

この分離の意図は「スキーマ定義は共有物、DB への書き込み権限は auth-worker だけ」という仕様書 2.2 / 7.2 の原則を、ツールのレベルでも成立させることにある。開発者のローカルから本番 D1 へ drizzle-kit で直接 push できる構成にしてはならない。

**注意**: `migrations_dir` は相対パスなので、`wrangler d1 migrations` 系のコマンドは必ず `apps/auth-worker` を CWD にして実行する。リポジトリルートから実行すると別の場所を見る。ルートの `pnpm db:migrate:local` / `pnpm db:migrate:remote` は `--filter @u18/auth-worker` 経由で CWD を正しく設定するため、こちらを使うのが安全である。

#### 3.1.2 手順: 生成 → レビュー → 適用

1. **スキーマを編集する。**

   ```bash
   # packages/db/src/schema/*.ts を編集
   cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services
   pnpm typecheck
   ```

2. **SQL を生成する。**

   ```bash
   pnpm db:generate
   ```

3. **生成された SQL をレビューする。** これが最も重要な工程であり、自動化してはならない。

   ```bash
   ls -t packages/db/drizzle/*.sql | head -1 | xargs cat
   git diff --stat packages/db/drizzle
   ```

   確認項目:
   - `DROP TABLE` / `DROP COLUMN` / `ALTER TABLE ... RENAME` が意図したものか。SQLite は列の削除・型変更でテーブル再作成を伴い、drizzle-kit は `__old_push_*` のような中間テーブルを使うことがある。データ量が多いと所要時間が読めない。
   - `NOT NULL` 列の追加に `DEFAULT` が付いているか。既存行があると付いていない場合に失敗する。
   - `UNIQUE INDEX` の追加が、既存データの重複で失敗しないか。特に `users_username_unique` / `users_primary_email_unique` は `lower()` 式インデックスなので、大文字小文字違いの既存行があると適用できない。
   - 機密列（`token_hash`、`code_hash`、`public_jwk` など）の型や制約が緩んでいないか。

4. **ローカルで適用して試す。**

   ```bash
   pnpm db:migrate:local
   pnpm test
   ```

5. **スキーマと SQL を同一コミットに含めてレビューへ出す。** `packages/db/src/schema/` の変更と `packages/db/drizzle/` の変更が揃っていないコミットは差し戻す。片方だけだと、次に誰かが `pnpm db:generate` したときに予期しない差分が出る。

6. **未適用マイグレーションを確認してから本番へ適用する。**

   ```bash
   cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
   npx wrangler d1 migrations list u18-identity --remote
   ```

   適用直前にバックアップ時点のブックマークを取っておく（§6.2）。

   ```bash
   cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services
   pnpm db:migrate:remote
   ```

   `wrangler d1 migrations apply` は適用前にバックアップを取得し、1 本のマイグレーションでエラーが起きた場合はそのマイグレーションをロールバックして直前の成功状態で止まる。ただし **複数本をまとめて適用して途中で失敗した場合、すでに成功した分は適用済みのまま残る。** 1 回のリリースで適用するマイグレーションは少数に保つ。

#### 3.1.3 絶対規則: マイグレーションはコードより先

**マイグレーションに依存するコードは、そのマイグレーションが本番 D1 に適用された後にしかデプロイしてはならない。**

Workers のデプロイは即時かつ全リージョンで切り替わる。新しい列を読むコードを先にデプロイすると、適用までの間、全リクエストが SQLite のエラーで落ちる。逆にマイグレーションを先に当てても、古いコードは新しい列を知らないだけなので動き続ける。

つまり、リリースは常に次の 2 段階にする。

1. `pnpm db:migrate:remote`
2. `npx wrangler deploy`

列の削除・リネームは逆向きの危険があるため、必ず 3 リリースに分ける。

1. 新しい列を追加するマイグレーションを当てる（古い列はそのまま残す）。両方の列に書き込むコードをデプロイする。
2. 新しい列だけを読むコードをデプロイする。
3. 古い列を削除するマイグレーションを当てる。

### 3.2 デプロイ順序

#### 3.2.1 通常のデプロイ（RPC 契約に変更なし）

`packages/contracts` に差分がない場合、両 Worker は独立にデプロイしてよい。順序の制約はない。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services
pnpm typecheck && pnpm test
cd apps/auth-worker     && npx wrangler deploy
cd ../dashboard-worker  && npx wrangler deploy
```

契約差分の有無はこれで判定する。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services
git diff <前回デプロイのコミット>..HEAD -- packages/contracts
```

#### 3.2.2 RPC 契約が変わるとき

RPC の呼び出し元（caller）は dashboard-worker、呼び出し先（callee）は auth-worker である。Service Binding は 2 つの Worker を同時に切り替えられない。デプロイの間には必ず「片方だけ新しい」時間帯が存在する。この時間帯に壊れない順序を選ぶ。

| 変更の種類                                                           | デプロイ順                                                    | 理由                                                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **メソッドの追加**、オプション引数の追加、レスポンスフィールドの追加 | **callee（auth-worker）が先**、caller（dashboard-worker）が後 | 中間状態は「auth-worker が新メソッドを持っているが誰も呼ばない」。害はない。逆順にすると、dashboard-worker が存在しないメソッドを呼び `TypeError` で 500 になる |
| **メソッドの削除**、引数の必須化、レスポンスフィールドの削除         | **caller（dashboard-worker）が先**、callee（auth-worker）が後 | 中間状態は「dashboard-worker がもう呼ばなくなったメソッドが auth-worker に残っている」。害はない。逆順にすると、dashboard-worker が消えたメソッドを呼んで落ちる |
| **シグネチャの変更**                                                 | 分割する                                                      | 「追加」と「削除」を 1 回で行うと、どちらの順序でも壊れる時間帯ができる。新しい名前のメソッドを追加 → caller を移行 → 古いメソッドを削除、の 3 リリースにする   |

#### 3.2.3 `CONTRACT_VERSION` の運用

`packages/contracts/src/version.ts` の `CONTRACT_VERSION`（現在 `1.0.0`）は semver として扱う。

- **PATCH**：コメント・型の別名など、ワイヤー形式に影響しない変更。デプロイ順の制約なし。
- **MINOR**：後方互換のある追加（上表の「追加」）。**callee 先行**。
- **MAJOR**：後方互換を壊す変更（上表の「削除」）。**caller 先行**。

規則:

1. `packages/contracts/src/` を変更する PR では、必ず `CONTRACT_VERSION` を同時に上げる。上げ忘れた PR は差し戻す。
2. **MAJOR を 1 リリースで上げてはならない。** 旧メソッドは最低 1 MINOR バージョン分は残し、`@deprecated` を付けて並走させる（`version.ts` のコメントが求めている「呼び出し元 Worker を先にデプロイできるよう旧メソッドを 1 バージョン分は残す」の実務上の意味）。
3. デプロイ記録に `CONTRACT_VERSION` を残す。`wrangler deploy --message` を使う。

   ```bash
   cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
   npx wrangler deploy --message "contract 1.1.0: add listGrants"
   ```

4. 緊急ロールバックのときも同じ順序を逆向きに適用する。MINOR 追加をロールバックする場合は caller（dashboard-worker）を先に戻し、その後 callee（auth-worker）を戻す。

#### 3.2.4 ロールバック

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler deployments list
npx wrangler rollback --message "incident: revert to <version-id>"
```

**マイグレーションはロールバックされない。** コードを戻しても DB スキーマは新しいままである。3.1.3 の「マイグレーションはコードより先」を守っていれば、古いコードは新しいスキーマ上で動く（知らない列を無視するだけ）ので、この組み合わせは安全である。守っていない場合、ロールバックでは復旧しない。

### 3.3 ヘルスチェック

#### 3.3.1 auth-worker の `/health`

実装は `apps/auth-worker/src/presentation/http/health.routes.ts` で、実際の疎通は `DatabaseProbe` Port（`apps/auth-worker/src/application/ports/health.port.ts`）の実装である `apps/auth-worker/src/infrastructure/persistence/drizzle-database-probe.ts` が行う。チェック内容は **D1 への `select 1` が成功するか、それだけ**である。

```bash
curl -i https://<auth-worker-の-URL>/health
```

| 観測                                                                      | 意味                                                                                                                                                 | 対応                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| HTTP 200、`{"status":"ok","checks":{"database":"ok"}}`                    | Worker が動き、D1 binding 越しにクエリが通った                                                                                                       | 正常                                |
| **HTTP 503**、`{"status":"degraded","checks":{"database":"unreachable"}}` | **Worker 自体は生きている。** Hono のルーティングもコンテナ生成も成功し、`select 1` だけが例外を投げた                                               | §5.4（D1 障害時の縮退）へ           |
| HTTP 500、`{"error":"internal_error"}`                                    | Worker は生きているが、コンテナ生成などリクエスト処理の別の箇所で例外。`ENVIRONMENT` が `development` 以外でメール未設定だとここに落ちる（1.5 参照） | `wrangler tail` でスタックを確認    |
| Cloudflare のエラーページ（1101 / 1102 / 522 など）、JSON が返らない      | **Worker が落ちている / デプロイが壊れている / Worker の例外が捕捉されていない**                                                                     | §3.3.3 へ                           |
| 接続自体が確立しない、DNS 解決に失敗                                      | ルーティング・DNS・Cloudflare 側の障害。Worker の問題ではない                                                                                        | Cloudflare のステータスページを確認 |

**503 と「Worker が落ちている」を混同しないこと。** 503 は、Worker が自分で自分の状態を診断して報告できた、ということである。アプリケーションコードは正常に動いている。切り分けの最初の一歩は「JSON が返ってきたか」である。

503 の原因候補は次の 3 つに絞られる。

1. `database_id` が誤っている、または `REPLACE_WITH_D1_DATABASE_ID` のまま（2.3）。
2. D1 データベースが削除された、または別アカウントのものを指している。
3. Cloudflare D1 側の障害。

1 と 2 は `wrangler d1 info u18-identity` で切り分けられる。

#### 3.3.2 dashboard-worker の `/health`

```bash
curl -i https://<dashboard-worker-の-URL>/health
```

**この endpoint は常に 200 を返す。** 実装（`apps/dashboard-worker/src/index.ts`）は固定の JSON を返すだけで、`IDENTITY` Service Binding の疎通を確認していない。auth-worker が完全に落ちていても緑になる。

したがって:

- **dashboard-worker の `/health` を外形監視の合否判定に使ってはならない。** 「Worker がデプロイされていてルーティングが生きている」以上の情報はない。
- 統合的な死活判定には auth-worker の `/health` を使う。
- dashboard-worker 側で RPC 障害を見たい場合は、Workers のログで `identity_unavailable` を検索する（`apps/dashboard-worker/src/infrastructure/rpc/identity.gateway.ts` がこの値に翻訳している）。

  ```bash
  cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/dashboard-worker
  npx wrangler tail u18-dashboard --format pretty --status error
  ```

#### 3.3.3 ログの見方

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler tail u18-auth --format pretty
npx wrangler tail u18-auth --format json --status error
npx wrangler tail u18-auth --search "database probe failed"
npx wrangler tail u18-auth --search "audit log write failed"
```

両 Worker とも `observability.enabled: true` なので、Cloudflare ダッシュボードの Workers Logs からも過去分を検索できる。

ログに現れる代表的なメッセージ:

| メッセージ                                                          | 出所                        | 意味                                                                                                                                                |
| ------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database probe failed`                                             | `drizzle-database-probe.ts` | D1 への `select 1` が失敗した。`/health` が 503 を返している                                                                                        |
| `unhandled error`                                                   | `app.ts` の `onError`       | 捕捉されなかった例外。詳細はクライアントへ返していない                                                                                              |
| `audit log write failed`                                            | `drizzle-audit-logger.ts`   | 監査ログの書き込みが失敗した。**認証自体は成功している。** 監査の欠落として扱う                                                                     |
| `EMAIL_PROVIDER is not configured for non-development environments` | `container.ts`              | §1.5 参照。`ENVIRONMENT` 設定ミスかメールプロバイダ未実装                                                                                           |
| `IP_HASH_PEPPER is not set outside development`                     | `container.ts`              | §1.5 / §2.4.2 参照。Secret 未設定のまま非 development で起動した                                                                                    |
| `[dev] OTP for ...`                                                 | `console-email-sender.ts`   | **本番でこれが出ていたら重大インシデント。** OTP が平文でログに記録されている。直ちに §5.3 相当の対応（`ENVIRONMENT` の是正とログの削除依頼）を行う |

ログに Cookie・セッショントークン・OTP・生 IP を出力するコードを追加してはならない（仕様書 4.4 / 9）。

---

## 4. 署名鍵のローテーション

### 4.1 前提と現在の制約

`signing_key_metadata`（`packages/db/src/schema/oauth.ts`）は 1 つの kid につき 1 行を持ち、次の 3 つの時刻で鍵のライフサイクルを表現する。

| 列             | 意味                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `active_from`  | この鍵で**新規署名してよくなる**時刻                                                                            |
| `active_until` | この鍵での**新規署名をやめる**時刻。`NULL` なら現役                                                             |
| `retires_at`   | この鍵を **JWKS から外してよい**時刻。`active_until` 以降も、発行済みトークンの検証のためここまでは公開し続ける |

秘密鍵はこのテーブルに入らない。`public_jwk` だけが入り、秘密鍵は Workers Secret の `SIGNING_KEY_JWK` に置く（仕様書 5.4 / 7.1）。

**現時点の制約を正直に書く。**

1. **JWKS endpoint（`/.well-known/jwks.json`）は未実装で 501 を返す。** したがって以下の手順は Phase 2 で JWKS が `signing_key_metadata` を読むようになって初めて最後まで実行できる。現時点では「テーブルに行を入れる」ところまでしか実行できず、公開鍵は配布されない。
2. **`SIGNING_KEY_JWK` は単一の Secret であり、秘密鍵は一度に 1 本しか持てない。** 「新旧 2 本を同時にロードして、どちらでも署名できる」構成にはなっていない。鍵の切り替えは Secret の置き換え 1 回で、全リクエストが瞬時に新鍵へ移る。段階的な比率移行はできない。
3. **`signing_key_metadata` の行と Secret の中身が一致しているかを検証する仕組みがない。** DB が kid-A を「現役」と記録していても、Secret に入っているのが kid-B の鍵であれば、ID Token の `kid` ヘッダと JWKS が食い違い、全 RP で検証が失敗する。手順 4.2 のステップ 6 の確認を省略しないこと。

将来、`SIGNING_KEY_JWK` を JWK Set（配列）として複数鍵を保持できる形に変え、署名鍵の選択を `signing_key_metadata` の `active_from` / `active_until` から行う実装にすべきである。本書はその改修前の前提で書いている。

### 4.2 定期ローテーション手順

実行の目安: 90 日ごと、または鍵に触れる権限を持つメンバーが離脱したとき。

所要時間の実質は待ち時間であり、作業そのものは 30 分程度。

#### ステップ 1 — 新しい鍵ペアを生成する

2.4.1 のコマンドを実行する。`kid` は日付入りにして、既存の kid と衝突しないようにする。

```bash
node -e '
const { generateKeyPairSync } = require("node:crypto");
const kid = `u18-${new Date().toISOString().slice(0, 10)}-1`;
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const meta = { alg: "ES256", use: "sig", kid };
console.log("SIGNING_KEY_KID=" + kid);
console.log("SIGNING_KEY_JWK=" + JSON.stringify({ ...privateKey.export({ format: "jwk" }), ...meta }));
console.log("PUBLIC_JWK=" + JSON.stringify({ ...publicKey.export({ format: "jwk" }), ...meta }));
'
```

秘密鍵（`d` を含む方）は、この後 Secret に入れるまでの間、安全な場所に一時的に置く。

#### ステップ 2 — 新しい公開鍵を JWKS に先行公開する

`signing_key_metadata` に新しい kid の行を入れる。ただし **`active_from` を未来に置く** ことで、「JWKS には載るが、まだ署名には使わない」状態を作る。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 execute u18-identity --remote --command "
insert into signing_key_metadata (kid, algorithm, public_jwk, active_from, active_until, retires_at, created_at)
values (
  'u18-2026-10-24-1',
  'ES256',
  '<PUBLIC_JWK をそのまま貼る>',
  (unixepoch() + 86400) * 1000,
  null,
  null,
  unixepoch() * 1000
);
"
```

時刻列は **epoch ミリ秒の INTEGER** である（`packages/db/src/schema/_shared.ts` の `timestampMs`）。SQLite の `unixepoch()` は秒を返すので、必ず 1000 倍する。これを忘れると 1970 年として解釈され、鍵のライフサイクル判定が全部狂う。

確認:

```bash
npx wrangler d1 execute u18-identity --remote --command "
select kid, algorithm,
       datetime(active_from/1000,  'unixepoch') as active_from,
       datetime(active_until/1000, 'unixepoch') as active_until,
       datetime(retires_at/1000,   'unixepoch') as retires_at
from signing_key_metadata order by active_from;
"
curl -s https://<auth-worker-の-URL>/.well-known/jwks.json | jq '.keys[].kid'
```

**この待ちが必要な理由**: RP（Relying Party）は JWKS をキャッシュする。キャッシュ期間中に未知の `kid` を持つ ID Token が届くと、RP の実装によっては JWKS を再取得せずそのまま検証失敗にする。新しい公開鍵を**先に**配っておくことで、署名を切り替えた瞬間に全 RP が既に新しい鍵を持っている状態を作る。

#### ステップ 3 — JWKS キャッシュが行き渡るのを待つ

**24 時間待つ。**

- RP 側の JWKS キャッシュ TTL は u18 からは制御できない。一般的な OIDC ライブラリの既定値は 5 分から 24 時間まで幅がある。
- この待ちは「最長の JWKS キャッシュ TTL」を見込んだものであり、トークンの寿命とは無関係である。
- 緊急時（§5.1）はこの待ちを省略する。その代償は「JWKS を再取得しない RP で一時的に検証失敗が出る」ことである。

#### ステップ 4 — 署名を新しい kid へ切り替える

旧鍵の `active_until` を現在時刻に設定し、新鍵の `active_from` を現在時刻に引き下げる。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 execute u18-identity --remote --command "
update signing_key_metadata set active_until = unixepoch() * 1000 where kid = '<旧 kid>' and active_until is null;
update signing_key_metadata set active_from  = unixepoch() * 1000 where kid = '<新 kid>';
"
```

続けて Secret を置き換える。**この 2 つの Secret は必ずセットで、かつ即座に続けて更新する。**

```bash
npx wrangler secret put SIGNING_KEY_JWK   # 新しい秘密鍵
npx wrangler secret put SIGNING_KEY_KID   # 新しい kid
```

Secret の更新は Worker の再デプロイなしに反映される。`SIGNING_KEY_JWK` だけ更新して `SIGNING_KEY_KID` が古いままの瞬間があると、その間に発行された ID Token は「旧 kid を名乗る新鍵署名」になり、RP では検証に失敗する。ID Token の寿命は 5 分なので影響は短時間だが、更新の間隔は数秒に収めること。

#### ステップ 5 — 発行済みトークンが自然に失効するのを待つ

**15 分待つ。**

内訳（仕様書 5.3 / `apps/auth-worker/src/domain/services/token-lifetime.ts`）:

| トークン           | 寿命      |
| ------------------ | --------- |
| Authorization Code | 60 秒     |
| **ID Token**       | **5 分**  |
| **Access Token**   | **10 分** |

現在、署名鍵で保護されている最長の寿命は **Access Token の 10 分** である（Access Token を JWT にする場合。不透明トークンにするなら署名鍵とは無関係になる。仕様書 14-5 が未決のため、保守的に JWT 前提で見込む）。ID Token は 5 分。Refresh Token は MVP では発行しない（仕様書 1.2）ので、これより長い寿命のトークンは存在しない。

切り替え直前に発行されたトークンを考慮して 10 分、クロックスキューと余裕を見て **15 分** とする。

**この待ちが必要な理由**: 切り替えの瞬間に発行済みで、まだ有効期限内の ID Token / Access Token が存在する。これらは旧 kid で署名されている。旧鍵を JWKS から今すぐ外すと、これらのトークンを持つユーザーのリクエストが一斉に検証失敗する。ブラウザセッション（最大 12 時間）はサーバー側の DB で検証しており署名鍵を使わないため、この待ちには含めない。

**Refresh Token を導入した場合、この待ち時間は Refresh Token の寿命まで延びる。** 本書の 15 分という数字は「現在は Refresh Token を発行していない」ことに依存している。仕様書 1.2 の方針が変わったらこの節を更新すること。

#### ステップ 6 — 新しい鍵で署名できていることを確認する

Phase 2 で `/oauth/token` が動くようになったら、実際に ID Token を取得してヘッダを確認する。

```bash
# ID Token のヘッダ部をデコードして kid を見る
echo "<ID Token>" | cut -d. -f1 | base64 -d 2>/dev/null | jq
```

`kid` が新しい値になっており、かつ JWKS にその kid が含まれていること。

```bash
curl -s https://<auth-worker-の-URL>/.well-known/jwks.json | jq '.keys[] | {kid, alg, crv}'
```

**DB と Secret の整合も確認する。** DB 上「現役」（`active_until is null`）の kid が 1 つだけで、それが `SIGNING_KEY_KID` と一致していること。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 execute u18-identity --remote --command "
select kid from signing_key_metadata where active_until is null;
"
```

この確認を飛ばすと、4.1 の制約 3 で述べた不一致が本番で表面化する。

#### ステップ 7 — 旧鍵の `retires_at` を設定する

ステップ 5 の待ちが終わってから、旧鍵の撤去予定時刻を記録する。

```bash
npx wrangler d1 execute u18-identity --remote --command "
update signing_key_metadata
set retires_at = (unixepoch() + 7 * 86400) * 1000
where kid = '<旧 kid>' and retires_at is null;
"
```

`retires_at` まで 7 日の猶予を置くのは、JWKS をディスク等に長期キャッシュしている RP や、障害時に旧鍵へ戻す必要が生じた場合への保険である。この期間中、旧鍵は **JWKS に載り続けるが新規署名には使われない**（`active_until` が過去なので）。

#### ステップ 8 — `retires_at` 到達後に JWKS から外す

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
# 撤去対象の確認
npx wrangler d1 execute u18-identity --remote --command "
select kid, datetime(retires_at/1000, 'unixepoch') as retires_at
from signing_key_metadata
where retires_at is not null and retires_at <= unixepoch() * 1000;
"
# 削除
npx wrangler d1 execute u18-identity --remote --command "
delete from signing_key_metadata where kid = '<旧 kid>';
"
```

Phase 2 の JWKS 実装は `retires_at <= now` の行を自動的に除外すべきである。そうなっていれば、この DELETE は行の掃除にすぎず、公開状態には影響しない。実装がそうなっていない場合、この DELETE が JWKS から鍵を外す唯一の手段になる。どちらであるかを実装時に確定させ、本節に追記すること。

#### ステップ 9 — 記録

鍵の生成日・kid・切り替え日時・実行者を運用記録に残す。秘密鍵そのものは残さない。

### 4.3 待ち時間の要約

| ステップ | 待ち    | 何を待っているか                                                               |
| -------- | ------- | ------------------------------------------------------------------------------ |
| 2 → 4    | 24 時間 | RP 側の JWKS キャッシュが更新されるのを待つ                                    |
| 4 → 7    | 15 分   | 旧鍵で署名済みの ID Token（5 分）/ Access Token（10 分）が自然失効するのを待つ |
| 7 → 8    | 7 日    | 長期キャッシュしている RP と、ロールバックのための保険                         |

---

## 5. インシデント対応

共通の初動:

1. 事象発生時刻、観測した内容、実行したコマンドを時系列で記録し始める。
2. `wrangler tail` を開き、以降のログを確保する（§3.3.3）。
3. 判断を下す前に、本節の該当プレイブックを最後まで読む。
4. 対応中の DB 操作はすべて `wrangler d1 execute --remote` の実行文ごと記録に残す。

### 5.1 署名鍵の漏洩が疑われる場合

#### 何が起きるか

`SIGNING_KEY_JWK` を持つ攻撃者は、**任意の `sub`・`aud`・`exp` を持つ ID Token を偽造できる**。u18 の RP は署名が正しく JWKS に載っている kid なので、正規のトークンと区別できない。実質的に全ユーザーへのなりすましが可能であり、u18 Identity を信頼する全サービスが影響を受ける。検知はログからは困難である（auth-worker を経由しないため、`audit_logs` に痕跡が残らない）。

#### 判断基準

次のいずれかに該当したら、鍵は漏洩したものとして扱う。確証を待たない。

- Secret の値が平文で画面共有・チャット・チケット・CI ログ等に出た。
- 鍵を扱った端末がマルウェア感染または盗難の疑いがある。
- Cloudflare アカウントへの不審なログインが検知された。
- 鍵へのアクセス権を持つメンバーの資格情報が漏れた。

#### 手順

1. **新しい鍵ペアを生成する。** 4.2 ステップ 1 と同じ。

2. **新しい kid を即座に現役として登録する。** 4.2 ステップ 2 の「24 時間の先行公開」は**省略する**。

   ```bash
   cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
   npx wrangler d1 execute u18-identity --remote --command "
   insert into signing_key_metadata (kid, algorithm, public_jwk, active_from, active_until, retires_at, created_at)
   values ('<新 kid>', 'ES256', '<PUBLIC_JWK>', unixepoch() * 1000, null, null, unixepoch() * 1000);
   "
   ```

3. **漏洩した鍵を即座に無効化する。** `active_until` を過去にするだけでは不十分で、`retires_at` も過去にして JWKS から完全に外す。**猶予期間を置かない。** 猶予を置くと、その間ずっと偽造トークンが検証に通る。

   ```bash
   npx wrangler d1 execute u18-identity --remote --command "
   update signing_key_metadata
   set active_until = unixepoch() * 1000, retires_at = unixepoch() * 1000
   where kid = '<漏洩した kid>';
   "
   npx wrangler d1 execute u18-identity --remote --command "
   delete from signing_key_metadata where kid = '<漏洩した kid>';
   "
   ```

4. **Secret を差し替える。**

   ```bash
   npx wrangler secret put SIGNING_KEY_JWK
   npx wrangler secret put SIGNING_KEY_KID
   ```

5. **JWKS から旧 kid が消えたことを確認する。**

   ```bash
   curl -s https://<auth-worker-の-URL>/.well-known/jwks.json | jq '.keys[].kid'
   ```

#### 何が壊れるか（事前に把握しておく）

- **旧鍵で署名された、まだ有効期限内の正規の ID Token / Access Token が、すべて検証失敗になる。** 最大で ID Token 5 分 / Access Token 10 分ぶんのユーザーがエラーに遭遇する。これは意図した代償である。偽造トークンを止めることが優先される。
- **JWKS を長期キャッシュしている RP は、新しい kid を知らないため一時的にすべての ID Token 検証に失敗する。** RP 側に JWKS キャッシュの破棄を依頼する連絡経路を、事前に用意しておくこと。
- **ブラウザセッションは壊れない。** セッションは `sessions` テーブルの `token_hash` で検証しており、署名鍵を使わない（`apps/auth-worker/src/application/use-cases/get-session.use-case.ts`）。ユーザーは再ログインを求められない。

#### 発行済みトークンの無効化

偽造された Access Token を個別に止める確実な手段は、現時点では存在しない。

- **Access Token が JWT の場合**（仕様書 14-5 未決）：署名鍵の撤去がそのまま無効化になる。上記手順 3 で完了する。
- **Access Token が不透明トークンの場合**：`oauth_tokens` に行があるので DB で失効できる。ただし偽造されたトークンは DB に行を持たないため、そもそも検証を通らない。つまり不透明トークン方式なら署名鍵漏洩の影響は ID Token に限定される。

  ```bash
  npx wrangler d1 execute u18-identity --remote --command "
  update oauth_tokens set revoked_at = unixepoch() * 1000 where revoked_at is null;
  "
  ```

- **ID Token は本質的に失効できない。** ステートレスであり、`exp` までは有効である。だから寿命を 5 分に抑えてある（仕様書 5.3）。鍵を JWKS から外すことが唯一の対抗手段である。

**この選択は仕様書 14-5（Access Token を不透明にするか JWT にするか）に直接かかってくる。** 不透明トークンを選べば、鍵漏洩時の無効化が DB 操作で完結し、本プレイブックは大幅に単純化される。運用の観点からは不透明トークンを推す。

#### 事後

1. 影響範囲（鍵が有効だった期間、その間に発行されたトークン数）を `audit_logs` から推定する。
2. 全 RP へ通知する。
3. 鍵の保管経路を見直し、漏洩した経路を塞ぐ。
4. 48 時間以内に 4.2 の通常ローテーションをもう一度実行し、緊急時に省略した先行公開のステップを踏んだ正常な状態に戻す。

### 5.2 特定ユーザーのアカウント侵害

#### 判断基準

- ユーザー本人からの申告。
- `audit_logs` に不審なイベント（見覚えのない地域からの `session.created`、短時間での `passkey.registered` など）。
- 想定外の Passkey 登録。

#### 手順

1. **対象ユーザーを特定する。** メールアドレスから `id` を引く。

   ```bash
   cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
   npx wrangler d1 execute u18-identity --remote --command "
   select id, username, status, email_verified,
          datetime(created_at/1000, 'unixepoch') as created_at
   from users where lower(primary_email) = lower('<メールアドレス>');
   "
   ```

2. **即時封じ込め — `status` を `suspended` にする。**

   ```bash
   npx wrangler d1 execute u18-identity --remote --command "
   update users set status = 'suspended', updated_at = unixepoch() * 1000 where id = '<USER_ID>';
   "
   ```

   **これが最速かつ最も確実な封じ込めである。** `GetSessionUseCase` はセッション検証のたびに `user.isActive` を確認し、`active` 以外なら期限内のセッションでも拒否する（`get-session.use-case.ts`）。1 行の UPDATE で、そのユーザーの全セッション・全デバイスが即座に通らなくなる。

3. **全セッションを失効させる。** `status` の変更だけでも通らなくなるが、復帰時に侵害されたセッションが生き返らないよう、明示的に失効させる。

   ```bash
   npx wrangler d1 execute u18-identity --remote --command "
   update sessions set revoked_at = unixepoch() * 1000
   where user_id = '<USER_ID>' and revoked_at is null;
   "
   ```

   時刻は epoch ミリ秒。`unixepoch()` をそのまま入れると 1970 年になる。

   **注**: `SessionRepository.revokeAllForUser()` が `apps/auth-worker/src/application/ports/session.repository.ts` に定義され `DrizzleSessionRepository` に実装済みだが、**これを呼び出す HTTP ルートも RPC メソッドも存在しない**（Phase 1 の未実装部分）。したがって現時点では上記の直接 SQL が唯一の手段である。Phase 1 の残りで管理用の入口を実装すること。

4. **同意（grant）を取り消す。** 侵害中に同意させられたアプリがある可能性を排除する。

   ```bash
   npx wrangler d1 execute u18-identity --remote --command "
   select g.id, c.client_id, c.name, g.granted_scopes,
          datetime(g.granted_at/1000, 'unixepoch') as granted_at
   from oauth_grants g join oauth_clients c on c.id = g.client_id
   where g.user_id = '<USER_ID>' and g.revoked_at is null;
   "
   npx wrangler d1 execute u18-identity --remote --command "
   update oauth_grants set revoked_at = unixepoch() * 1000, updated_at = unixepoch() * 1000
   where user_id = '<USER_ID>' and revoked_at is null;
   "
   ```

5. **発行済みトークンを失効させる。** `oauth_tokens` は `grant_id` に `onDelete: cascade` の外部キーを持つが、grant の `revoked_at` を立てただけではトークンは自動失効しない。明示的に失効させる。

   ```bash
   npx wrangler d1 execute u18-identity --remote --command "
   update oauth_tokens set revoked_at = unixepoch() * 1000
   where user_id = '<USER_ID>' and revoked_at is null;
   "
   ```

6. **未使用の認可コードと未消費のチャレンジを潰す。**

   ```bash
   npx wrangler d1 execute u18-identity --remote --command "
   update oauth_authorization_codes set consumed_at = unixepoch() * 1000
   where user_id = '<USER_ID>' and consumed_at is null;
   update email_challenges set consumed_at = unixepoch() * 1000
   where user_id = '<USER_ID>' and consumed_at is null;
   update webauthn_challenges set consumed_at = unixepoch() * 1000
   where user_id = '<USER_ID>' and consumed_at is null;
   "
   ```

7. **認証要素を棚卸しする。** 攻撃者が登録した Passkey を特定する。

   ```bash
   npx wrangler d1 execute u18-identity --remote --command "
   select id, label, device_type, backed_up,
          datetime(created_at/1000,    'unixepoch') as created_at,
          datetime(last_used_at/1000,  'unixepoch') as last_used_at
   from passkeys where user_id = '<USER_ID>' order by created_at;
   "
   ```

   本人に心当たりのない Passkey を削除する。

   ```bash
   npx wrangler d1 execute u18-identity --remote --command "
   delete from passkeys where id = '<PASSKEY_ID>' and user_id = '<USER_ID>';
   "
   ```

8. **監査ログを保全する。** 対応で状態を変える前に取得しておくのが望ましい。

   ```bash
   npx wrangler d1 execute u18-identity --remote --json --command "
   select datetime(created_at/1000, 'unixepoch') as at, event, outcome, reason, actor, ip_hash, user_agent
   from audit_logs where user_id = '<USER_ID>' order by created_at desc limit 500;
   " > /tmp/u18-incident-<USER_ID>.json
   ```

   `ip_hash` は `IP_HASH_PEPPER` でハッシュ化されている。特定の IP が関与したかを確かめるには、同じ pepper で候補 IP をハッシュして突き合わせる。**この作業のために pepper を調査用端末へコピーしないこと。** 必要なら Worker 側に照合用の管理機能を実装する。

9. **本人確認のうえ再登録させる。**

   - 本人確認はメール OTP だけに依存させない（仕様書 6.1）。攻撃者がメールを掌握している可能性がある。
   - 本人確認が取れたら `status` を `active` に戻す。

     ```bash
     npx wrangler d1 execute u18-identity --remote --command "
     update users set status = 'active', updated_at = unixepoch() * 1000 where id = '<USER_ID>';
     "
     ```

   - ユーザーに Passkey を新規登録させる。

   **再登録の強制（force re-enrollment）フローは未実装である。** 「次回ログイン時に必ず Passkey を再登録させる」フラグを立てる仕組みが `users` にも `sessions` にもない。現時点では、全 Passkey を削除したうえでメール OTP での復帰を案内する運用でしのぐしかない。Phase 1 の残り、または Phase 3 で本フローを実装すること。管理権限を持つアカウントの復旧ポリシーは仕様書 14-8 が未決であり、§8 に記載した。

### 5.3 総当たり / 異常トラフィックの検知時

#### 重要な前提

**レート制限は未実装である。** 仕様書 9（Abuse）と Phase 3 で予定されているが、現在のコードには Rate Limiting も Turnstile も存在しない。`email_challenges` の `max_attempts`（既定 5）と `resend_count` はスキーマにあるが、これを強制する UseCase がまだない（OTP 自体が 501）。

したがって現時点で取りうるのは **Cloudflare のエッジ側の対策**と**観測**だけである。

#### 検知

1. Cloudflare ダッシュボードの Workers Analytics で、リクエスト数・エラー率・CPU 時間の急増を見る。
2. ログを絞って観測する。

   ```bash
   cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
   npx wrangler tail u18-auth --format json --status error
   npx wrangler tail u18-auth --method POST
   npx wrangler tail u18-auth --ip <疑わしい IP>
   ```

3. 監査ログで失敗の偏りを見る。

   ```bash
   npx wrangler d1 execute u18-identity --remote --command "
   select event, reason, count(*) as n
   from audit_logs
   where outcome = 'failure' and created_at > (unixepoch() - 3600) * 1000
   group by event, reason order by n desc;
   "
   ```

   同一 `ip_hash` からの集中:

   ```bash
   npx wrangler d1 execute u18-identity --remote --command "
   select ip_hash, count(*) as n, count(distinct user_id) as users
   from audit_logs
   where outcome = 'failure' and created_at > (unixepoch() - 3600) * 1000
   group by ip_hash order by n desc limit 20;
   "
   ```

   `count(distinct user_id)` が大きい場合は、1 つの IP が多数のアカウントを試している（credential stuffing / user enumeration）。1 ユーザーに集中している場合は特定アカウントへの総当たりであり、§5.2 の封じ込めを併用する。

   ```bash
   npx wrangler d1 execute u18-identity --remote --command "
   select user_id, count(*) as n
   from audit_logs
   where event = 'session.rejected' and created_at > (unixepoch() - 3600) * 1000
   group by user_id order by n desc limit 20;
   "
   ```

#### 対応

1. **Cloudflare WAF / Rate Limiting Rules をダッシュボードで設定する。** auth-worker の前段で止める。これが現時点で最も効く。対象パスの優先順位:
   - `/api/auth/email/start`、`/api/auth/email/verify`（OTP。実装後は最優先）
   - `/api/auth/passkeys/login/*`
   - `/oauth/token`
   - `/health`（**認証なしで D1 にクエリを打つ唯一の公開 endpoint である。** 1 リクエストにつき 1 回 D1 を叩くため、増幅攻撃の的になりやすい。監視元 IP だけに許可するか、エッジでレート制限をかける）
2. **特定 IP / ASN / 国をブロックする。** Cloudflare の Firewall Rules で行う。Worker のコードを変えないので即時に効く。
3. **広範囲の攻撃なら Under Attack Mode を検討する。** 正規ユーザーにも JS チャレンジが出るため、影響を周知してから。
4. **標的アカウントを保護する。** 特定ユーザーへの総当たりなら、一時的に `status = 'suspended'` にして本人へ連絡する（§5.2 手順 2）。
5. **D1 への負荷を監視する。**

   ```bash
   npx wrangler d1 insights u18-identity
   ```

6. **恒久対応として Phase 3 のレート制限を前倒しする判断をする。** 一度攻撃を受けたら、WAF ルールだけで運用を続けない。

#### 絶対にやらないこと

- 対応のために `ENVIRONMENT` を `development` に変える。メール送信が `ConsoleEmailSender` に落ち、OTP がログに流れる。
- ログに生 IP を出力するコードを緊急追加する。仕様書 9（Privacy）違反であり、インシデント後も残りやすい。

### 5.4 D1 障害時の縮退

#### 症状

- auth-worker の `/health` が **503**、`checks.database` が `unreachable`（§3.3.1）。
- ログに `database probe failed`。
- dashboard-worker の `/health` は **200 のまま**（§3.3.2）。騙されないこと。

#### 動くもの / 動かないもの

| 機能                                             | D1 障害時           | 理由                                                                                                                    |
| ------------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/openid-configuration`          | **動く**            | `oauth.routes.ts` は `c.env.ISSUER` から静的に組み立てており、DB を読まない                                             |
| `GET /health`                                    | **応答する（503）** | 診断が目的。503 を返すこと自体が正常動作                                                                                |
| 501 を返す各 endpoint                            | 動く（501 のまま）  | DB に触れていない                                                                                                       |
| `GET /api/me`、`GET /api/me/sessions`            | **動かない**        | セッション検証が `sessions` テーブルを引く                                                                              |
| `DELETE /api/me/sessions/:id`                    | **動かない**        | 同上                                                                                                                    |
| `IdentityRPC` の全メソッド                       | **動かない**        | すべて `createContainer` 経由で D1 を使う                                                                               |
| dashboard-worker の `/api/me` 系                 | **動かない**        | RPC が失敗し、`identity_unavailable` → HTTP 503 に翻訳される                                                            |
| ログイン（Phase 1 残り）、OIDC フロー（Phase 2） | **動かない**        | セッション・認可コード・OTP の正本はすべて D1                                                                           |
| **既存セッションでの RP 側の継続利用**           | **RP の実装による** | RP が ID Token を検証済みで自前のセッションを持っていれば、u18 に問い合わせない限り動き続ける                           |
| JWKS（Phase 2 実装後）                           | **動かない見込み**  | `signing_key_metadata` を読むため。実装時に、現役の鍵を Secret 側の値だけで応答できるフォールバックを検討する価値がある |

要するに、**D1 が落ちると u18 Identity は「新規の認証判断が一切できない」状態になる。** 読み取り専用で縮退する余地はない。セッションも認可コードも D1 が正本であり、KV をセッションの正本にしないことは仕様書 7.3 で明示的に決めてある。

#### 手順

1. **切り分ける。** Worker の問題か D1 の問題かを確定する。

   ```bash
   curl -i https://<auth-worker-の-URL>/health
   curl -i https://<auth-worker-の-URL>/.well-known/openid-configuration
   ```

   Discovery が 200 で `/health` が 503 なら、Worker は健全で D1 だけが落ちている。

2. **設定ミスを除外する。** 直前にデプロイがあった場合、`database_id` が壊れた可能性を先に潰す。

   ```bash
   cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services
   grep -n "database_id" apps/auth-worker/wrangler.jsonc
   cd apps/auth-worker
   npx wrangler d1 info u18-identity
   npx wrangler d1 execute u18-identity --remote --command "select 1;"
   ```

   `wrangler d1 info` が通るのに Worker から見えない場合、デプロイされた Worker の binding が古い。直近のデプロイをロールバックする（§3.2.4）。

3. **Cloudflare 側の障害を確認する。** `https://www.cloudflarestatus.com/` で D1 のステータスを見る。障害中なら復旧を待つ以外にない。

4. **ユーザーへ告知する。** 「ログインできない」ことを伝える。既存の RP セッションは生きている可能性があるので、「ログアウトしないよう」案内するのが実務的に有効である。

5. **復旧を確認する。**

   ```bash
   curl -s https://<auth-worker-の-URL>/health | jq
   cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
   npx wrangler d1 migrations list u18-identity --remote
   ```

   マイグレーションの適用状態が復旧前と一致していることを確認する。Cloudflare 側で巻き戻しが発生した可能性を否定するため。

6. **事後**: 障害中に `audit_logs` の書き込みも失敗している（`drizzle-audit-logger.ts` は書き込み失敗を握り潰してログに出すだけ）。障害時間帯の監査ログには欠落があると記録しておく。

---

## 6. バックアップと復旧

### 6.1 D1 の保護手段

D1 には 2 つの独立した手段がある。両方を使う。

| 手段                     | 保持期間           | 用途                                           | 限界                                                                                     |
| ------------------------ | ------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Time Travel**          | **直近 30 日**     | 操作ミス・不正なマイグレーションからの巻き戻し | Cloudflare アカウント内に閉じる。アカウント自体を失うと使えない。30 日より前には戻せない |
| **`wrangler d1 export`** | 任意（保管先次第） | オフサイト保管、長期保全、別環境への複製       | 実行時点のスナップショット。実行していなければ存在しない                                 |

Time Travel は自動で有効であり、設定は不要である。**ただし「自動バックアップがある」ことと「復旧できる」ことは別である。** §6.4 のリハーサルを行っていないバックアップは、バックアップとして数えない。

### 6.2 Time Travel

#### 現在のブックマークを取得する

危険な操作（マイグレーション、インシデント対応の一括 UPDATE / DELETE）の**直前に必ず実行し、出力を記録に残す。**

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 time-travel info u18-identity
```

特定時刻のブックマークを引く:

```bash
npx wrangler d1 time-travel info u18-identity --timestamp 2026-10-24T03:00:00Z
```

#### 復元する

```bash
# ブックマーク指定（推奨。正確に戻れる）
npx wrangler d1 time-travel restore u18-identity --bookmark <BOOKMARK>

# 時刻指定（RFC3339 または Unix 秒。直近 30 日以内）
npx wrangler d1 time-travel restore u18-identity --timestamp 2026-10-24T03:00:00Z
```

**Time Travel の復元は破壊的である。** 復元時点以降のすべての書き込みが失われる。実行前に必ず現在時点のブックマークも取得しておくこと（復元を取り消したくなったとき、その時点へ戻すために必要）。

Identity DB の場合、復元によって失われるのは典型的には次である。復旧判断のときに天秤にかけること。

- 復元時点以降に作成されたユーザーアカウント（そのユーザーは消える）
- 復元時点以降に登録された Passkey（登録したユーザーがログインできなくなる）
- 復元時点以降に**失効させたセッション**（**失効が取り消され、セッションが復活する**）
- 復元時点以降の `audit_logs`（インシデント調査の証跡が消える）

3 番目が特に危ない。インシデント対応で侵害セッションを失効させた後に Time Travel で巻き戻すと、**攻撃者のセッションが生き返る。** 復元後は必ず §5.2 の封じ込めをやり直す。

### 6.3 エクスポート

#### 手動エクスポート

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 export u18-identity --remote \
  --output "/secure/backups/u18-identity-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

スキーマだけ（構造確認・差分検証用。機密を含まない）:

```bash
npx wrangler d1 export u18-identity --remote --no-data \
  --output "/tmp/u18-identity-schema-$(date -u +%Y%m%d).sql"
```

#### エクスポートファイルの取り扱い

このファイルは `sessions.token_hash`、`email_challenges.code_hash`、`passkeys.public_key`、`users.primary_email`、`audit_logs.ip_hash` を含む。**Identity DB のフルダンプは、署名鍵に次いで機密性が高い成果物である。**

1. 保管先は暗号化されたストレージに限る。開発者のローカル `~/Downloads` に置いたまま放置しない。
2. 保管先へのアクセス権は、本番 Secret にアクセスできるメンバーと同じかそれ以下にする。
3. `IP_HASH_PEPPER` と同じ場所に保管しない。pepper とダンプが揃うと IP が復元できる（§1.4）。
4. 転送はチャットやメールを使わない。
5. 不要になったら削除する。

#### 必要な保持期間

| データ                             | 必要な保持                                                     | 根拠                                                                                 |
| ---------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 日次相当のスナップショット         | 最低 30 日                                                     | Time Travel の窓と揃える                                                             |
| 週次相当のスナップショット         | 最低 90 日                                                     | Time Travel の窓を超える範囲の保険。長期にわたって気づかれなかったデータ破壊への対応 |
| マイグレーション直前のエクスポート | そのマイグレーションがロールバック不能になるまで（目安 30 日） | スキーマ変更の失敗は Time Travel の窓内で気づけないことがある                        |

#### 未決定 — バックアップ頻度

**エクスポートの実行頻度・自動化手段・保管先は未決定である。** 現在、スケジュール実行の仕組み（Cron Trigger、CI のスケジュールジョブ、外部のバックアップ基盤）は一切構成されていない。リポジトリに `.github/workflows` も存在しない。したがって **現時点ではエクスポートは「誰かが手で実行したときだけ存在する」。**

本番公開（Phase 3）までに次を決めること。

1. **頻度**。Identity DB の書き込み頻度は高くない（ユーザー登録、ログイン、セッション失効）ので、日次で足りる可能性が高い。ただしセッション行は高頻度で INSERT / UPDATE される。RPO（許容できるデータ損失時間）を決めてから頻度を決める。
2. **実行主体**。Cloudflare Cron Trigger から Worker 内で `d1 export` 相当を行う経路は存在しないため、外部の CI / スケジューラから `wrangler` を実行する形になる。その実行環境が本番 D1 への読み取り権限を持つことになるので、トークンのスコープを最小にする。
3. **保管先と暗号化**。
4. **保管先からの削除（ローテーション）**。古いダンプが無期限に残ると、それ自体が情報漏洩の面になる。

この決定がつくまでは、**マイグレーション適用前とインシデント対応前に手動でエクスポートする**ことを必須の運用とする（§3.1.2 ステップ 6、§5 共通初動）。

### 6.4 復旧リハーサルのチェックリスト

四半期に 1 回、および本番公開前に 1 回、実施する。**本番 DB に対して復元を試さない。** 別の D1 データベースを作って行う。

1. [ ] リハーサル用の D1 を作る。

   ```bash
   cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
   npx wrangler d1 create u18-identity-restore-drill
   ```

2. [ ] 本番から最新のエクスポートを取得する（§6.3）。所要時間を記録する。
3. [ ] エクスポートをリハーサル用 D1 へ流し込む。所要時間を記録する。

   ```bash
   npx wrangler d1 execute u18-identity-restore-drill --remote \
     --file /secure/backups/<最新のダンプ>.sql -y
   ```

4. [ ] テーブルが 13 個揃っていることを確認する。

   ```bash
   npx wrangler d1 execute u18-identity-restore-drill --remote \
     --command "select name from sqlite_master where type='table' order by name;"
   ```

5. [ ] 主要テーブルの行数が本番と一致することを確認する。

   ```bash
   for t in users user_emails passkeys sessions oauth_clients oauth_grants oauth_tokens signing_key_metadata audit_logs; do
     echo "-- $t"
     npx wrangler d1 execute u18-identity-restore-drill --remote --command "select count(*) from $t;"
   done
   ```

6. [ ] マイグレーションの適用状態が一致することを確認する。

   ```bash
   npx wrangler d1 migrations list u18-identity-restore-drill --remote
   ```

7. [ ] 一意制約・インデックスが復元されていることを確認する（ダンプの流し込みで落ちやすい箇所）。

   ```bash
   npx wrangler d1 execute u18-identity-restore-drill --remote \
     --command "select name, tbl_name from sqlite_master where type='index' and name not like 'sqlite_%' order by tbl_name;"
   ```

8. [ ] Time Travel の復元も試す。リハーサル用 DB に何か書き込み、ブックマークを取り、さらに書き込み、ブックマークへ戻して差分が消えることを確認する。
9. [ ] **切り替え手順を確認する**。復元した DB を本番として使う場合、`apps/auth-worker/wrangler.jsonc` の `database_id` を差し替えて `wrangler deploy` が必要になる。この間 auth-worker は旧 DB を見続ける。この「切り替えのダウンタイム」を実測して記録する。
10. [ ] リハーサル用 D1 を削除する。**削除しないと、本番データのコピーが放置される。**

    ```bash
    npx wrangler d1 delete u18-identity-restore-drill
    ```

11. [ ] 手元に落としたダンプを削除する。
12. [ ] 所要時間の合計を記録し、RTO（目標復旧時間）の見積もりを更新する。
13. [ ] 手順中に詰まった箇所を本ドキュメントへ反映する。

---

## 7. データ保持と削除

### 7.1 アカウント削除

#### スキーマ上の前提

`users` には論理削除のための 2 つの要素がある。

- `status`（`active` / `suspended` / `deleted`）
- `deleted_at`（`timestamp_ms`、NULL 可）

**重要 — 認証の遮断に効くのは `status` だけである。** `User.isActive`（`apps/auth-worker/src/domain/entities/user.ts`）は `status === "active"` しか見ておらず、`deleted_at` を参照していない。`deleted_at` だけを設定しても、そのユーザーは **引き続きログインできる。** 削除処理では必ず両方を設定する。

即時に物理削除しない理由は、監査ログとの整合、誤削除からの復旧、法的な照会への対応である（`packages/db/src/schema/users.ts` のコメント / 仕様書 7.3）。

#### 削除手順

**セルフサービスのアカウント削除 API は未実装である。** `PATCH /api/me` すら 501 であり、削除の入口は存在しない。現時点では運用者が手動で実行する。

1. **本人確認を行う。** 削除は不可逆に近い。なりすましによる削除要求を通さないため、§5.2 と同等の本人確認を行う。

2. **対象を特定し、削除前の状態を記録する。**

   ```bash
   cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
   npx wrangler d1 execute u18-identity --remote --command "
   select id, username, status, datetime(created_at/1000, 'unixepoch') as created_at
   from users where lower(primary_email) = lower('<メールアドレス>');
   "
   ```

3. **エクスポートを取る**（§6.3）。削除は Time Travel の 30 日窓を超えると取り消せない。

4. **論理削除する。`status` と `deleted_at` を必ず両方。**

   ```bash
   npx wrangler d1 execute u18-identity --remote --command "
   update users
   set status = 'deleted', deleted_at = unixepoch() * 1000, updated_at = unixepoch() * 1000
   where id = '<USER_ID>' and deleted_at is null;
   "
   ```

5. **セッション・同意・トークンを失効させる。** §5.2 の手順 3・4・5 と同じ SQL を実行する。`status = 'deleted'` だけでも `GetSessionUseCase` で弾かれるが、明示的に失効させて状態を整合させる。

6. **認証要素を削除する。** Passkey は本人の認証器に紐づくため、論理削除の猶予期間を待たずに消してよい。

   ```bash
   npx wrangler d1 execute u18-identity --remote --command "
   delete from passkeys where user_id = '<USER_ID>';
   delete from webauthn_challenges where user_id = '<USER_ID>';
   delete from email_challenges where user_id = '<USER_ID>';
   "
   ```

7. **メールアドレスを解放するかどうかを決める。** `users.primary_email` と `user_emails.email` には `lower()` 式の UNIQUE インデックスがある。削除済みユーザーの行が残っている限り、**同じメールアドレスでの再登録ができない。** 猶予期間中に再登録を許すなら、`user_emails` の行を削除するか、アドレスをトゥームストーン値（例: `deleted+<USER_ID>@invalid`）へ書き換える必要がある。

   **この挙動は現在のスキーマの帰結であり、仕様書には記載がない。** 「削除したのに同じメールで作り直せない」という問い合わせは必ず発生する。方針を決めて本節に追記すること。

8. **猶予期間の経過後に物理削除する。**

   猶予期間は **30 日** を推奨する（Time Travel の窓と揃え、誤削除から確実に戻せる範囲にする）。

   ```bash
   # 対象の確認
   npx wrangler d1 execute u18-identity --remote --command "
   select id, datetime(deleted_at/1000, 'unixepoch') as deleted_at
   from users
   where deleted_at is not null and deleted_at < (unixepoch() - 30 * 86400) * 1000;
   "
   # 物理削除。user_emails / passkeys / sessions / oauth_grants / oauth_tokens /
   # oauth_authorization_codes は user_id の外部キーに onDelete: cascade が設定されており、
   # users の行を消すと連鎖削除される。
   npx wrangler d1 execute u18-identity --remote --command "
   delete from users where id = '<USER_ID>';
   "
   ```

   **`audit_logs` は連鎖削除されない。** `audit_logs.user_id` は外部キーではなく、ただの `text` 列である（`packages/db/src/schema/audit.ts`）。これは意図的で、ユーザーを消しても監査の証跡が残るようにしてある。つまり **物理削除後も `audit_logs.user_id` に ID が残り続ける。** 完全な消去を求められた場合は、別途この列を匿名化する必要がある。

   ```bash
   npx wrangler d1 execute u18-identity --remote --command "
   update audit_logs set user_id = null, ip_hash = null, user_agent = null where user_id = '<USER_ID>';
   "
   ```

   **ただしこれは監査証跡を失う操作である。** 「削除要求への対応」と「セキュリティ証跡の保全」のどちらを優先するかは、§8 の未決事項として扱うべき方針判断である。

**この一連の処理を自動化するバッチは存在しない。** 猶予期間を過ぎた論理削除ユーザーを定期的に物理削除する仕組み（Cron Trigger またはスケジュールジョブ）が必要である。Phase 3 の「アカウント削除・復旧手順」で実装する。

### 7.2 `audit_logs` の保持

#### 現状

- 保持期間は**未定義**である。
- 削除・アーカイブのバッチは**存在しない**。したがって現在は**無期限に増え続ける**。
- `audit_logs` にはインデックスが 3 本（`event+created_at`、`user_id+created_at`、`created_at`）あり、行数に比例してストレージを消費する。D1 のデータベースサイズには上限があるため、放置すれば最終的に書き込みが止まる。
- 書き込み失敗は握り潰される（`drizzle-audit-logger.ts`）。つまり **DB が容量上限に達しても、認証は動き続け、監査ログだけが静かに欠落する。** ログに `audit log write failed` が出るので、これを監視対象に入れること。

#### 推奨する保持方針（Phase 3 で確定させる）

| 区分                                                                                     | 推奨保持期間 | 理由                                                   |
| ---------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------ |
| セキュリティイベント全般（`session.created`、`session.rejected`、`session.revoke` など） | **180 日**   | インシデントの発覚は遅れる。直近半年を遡れる必要がある |
| 認証失敗（`outcome = 'failure'`）                                                        | **180 日**   | 総当たりの長期的パターン分析に使う                     |
| 高リスクイベント（鍵ローテーション、アカウント停止・削除、管理操作）                     | **2 年**     | 件数が少なく、保持コストに対して価値が高い             |

#### 削除の手順（実装までの暫定運用）

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
# 対象件数の確認
npx wrangler d1 execute u18-identity --remote --command "
select count(*) from audit_logs where created_at < (unixepoch() - 180 * 86400) * 1000;
"
# 削除前にエクスポートする（§6.3、--table を使って audit_logs だけ）
npx wrangler d1 export u18-identity --remote --table audit_logs \
  --output "/secure/backups/u18-audit-$(date -u +%Y%m%d).sql"
# 削除
npx wrangler d1 execute u18-identity --remote --command "
delete from audit_logs where created_at < (unixepoch() - 180 * 86400) * 1000;
"
```

一度に大量の行を削除すると D1 のクエリ時間上限に当たる。初回は期間を区切って小分けに実行する。

#### 期限切れ行の掃除（audit_logs 以外）

同じ問題が他のテーブルにもある。**いずれも期限切れ行を掃除するバッチは存在しない。**

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 execute u18-identity --remote --command "
select 'sessions',                   count(*) from sessions                   where expires_at < unixepoch() * 1000
union all select 'oauth_authorization_codes', count(*) from oauth_authorization_codes where expires_at < unixepoch() * 1000
union all select 'email_challenges',          count(*) from email_challenges          where expires_at < unixepoch() * 1000
union all select 'webauthn_challenges',       count(*) from webauthn_challenges       where expires_at < unixepoch() * 1000
union all select 'oauth_tokens',              count(*) from oauth_tokens              where expires_at < unixepoch() * 1000;
"
```

`sessions` は 12 時間で期限切れになるため、最も速く増える。セッション行の保持は「期限切れ後 30 日」程度にし（セッション一覧 UI での履歴表示と調査のため）、それ以降は削除する方針を Phase 3 で確定させる。認可コード・チャレンジ類は期限切れ後すぐに消してよい（`consumed_at` の記録が必要なら `audit_logs` 側に残す）。

### 7.3 `ipHash` の保持 — 未決の論点

`ip_hash` は 2 箇所にある。

- `sessions.ip_hash` — セッション一覧 UI で「どこからログインしているか」を示すため
- `audit_logs.ip_hash` — 不正アクセス調査のため

生 IP は保存していない（仕様書 9 Privacy）。`PepperedIpHasher` が `IP_HASH_PEPPER` を混ぜて SHA-256 を取る。pepper がなければ IPv4 空間は総当たり可能なので、pepper の秘匿が匿名化の前提である。

**未決**: `ip_hash` を何日保持するか。

- **匿名化の観点**: `ip_hash` は完全な匿名データではない。pepper を持つ側から見れば、同一 IP かどうかの照合が可能な擬似識別子である。未成年ユーザーの接続元という性質上、保持は短いほどよい。
- **セキュリティ運用の観点**: 侵害調査では「いつもと違う場所からのログイン」の判断に使う。数か月分がないと長期的な攻撃パターンが見えない。
- **検討している選択肢**:
  1. `audit_logs` 本体の保持期間（180 日）と揃える。最も単純。
  2. `ip_hash` だけを短く（例: 90 日）し、期限後は `NULL` に更新する。イベント自体は残るので監査の連続性は保たれる。

     ```bash
     npx wrangler d1 execute u18-identity --remote --command "
     update audit_logs set ip_hash = null
     where ip_hash is not null and created_at < (unixepoch() - 90 * 86400) * 1000;
     "
     ```

  3. `IP_HASH_PEPPER` を定期的にローテーションし、古い hash を照合不能にする。**ただし現在の実装には pepper のバージョン管理がない。** pepper を変えた瞬間、過去の `ip_hash` は新しい hash と照合できなくなるが、古い pepper が漏れれば依然として復元可能である。列に pepper 世代を記録する設計変更が前提になる。

**この決定が済むまでは、`ip_hash` は `audit_logs` の保持期間に従うものとして扱う。** 選択肢 2 を推すが、運用方針として確定していない。仕様書 9 の「情報公開範囲、削除・保持期間を明示」はこの点を含んでいる。

---

## 8. 未決事項と、それが止めている運用判断

仕様書 14 の項目のうち、本番運用を直接止めているものを運用の言葉で言い換える。各項目は「決まらないと何が書けないか」を伴う。

### 8.1 本番 Issuer ドメインと Cookie のドメイン・サイト境界（仕様書 14-1）

**現状**: `ISSUER` は `http://localhost:8787` のまま。`RP_ID` は `localhost`。セッション Cookie の名前は `ENVIRONMENT` で切り替わり、本番では `__Host-u18_session` になる（`packages/contracts/src/session-cookie.ts`）。

**止めている運用判断**:

1. **`wrangler.jsonc` に本番環境セクションを書けない。** §1.5 で述べたとおり、`env.production` が未定義のため、現在のデプロイは `ENVIRONMENT=development` を本番に持ち込む。ドメインが決まらないと `ISSUER` / `RP_ID` / `WEBAUTHN_ORIGIN` の正しい値が書けず、この環境分離が完成しない。**これが本番公開の最大のブロッカーである。**
2. **`__Host-` を選んだ時点で、ホスト構成の選択肢が 3 つに絞られている。** Cookie 名自体は `packages/contracts/src/session-cookie.ts` で両 Worker が共有しており、名前の食い違いはない。しかし `__Host-` 接頭辞はブラウザに `Domain` 属性を禁じさせるため、**Cookie は発行したホストにしか送られない。** したがって本番では次のいずれかを選ぶことになる（同ファイルのコメントが列挙している）。
   1. auth と dashboard を**同一ホスト**に載せ、パスで分ける。`__Host-` の保護を維持できる。dashboard-worker の現在の Cookie 読み取りはこの構成を暫定の前提にしている。
   2. `Domain=.u18.example` の共有 Cookie にする。サブドメインからの Cookie 上書きを防ぐ `__Host-` の保護を捨てることになる。
   3. dashboard は Cookie を使わず、auth から別経路でトークンを受け取る。

   **ホスト構成を決めるまで dashboard-worker を本番公開してはならない。** 構成 2 や 3 を選んだ場合、現在の実装は動かない。

3. **`DELETE` の Origin 検証が設定依存になる。** `apps/auth-worker/src/presentation/http/me.routes.ts` は `Origin` ヘッダを `c.env.ISSUER` と**厳密一致**で比較し、`Origin` が無いリクエストも拒否する（fail-closed）。実際に配信される Origin と `ISSUER` が 1 文字でも違う（末尾スラッシュ、ポート、`www` の有無）と、セッション失効 API が全件 403 になる。また `Origin` を送らない非ブラウザクライアント（`curl` の素のリクエストを含む）も 403 になるため、運用で叩くときは `-H "Origin: <ISSUER と完全一致する値>"` を付ける必要がある。ドメイン確定後、必ず実機で `DELETE /api/me/sessions/:id` を叩いて確認すること。dashboard-worker 側は `ISSUER` ではなく自分のリクエスト URL の Origin と比較しているため、**auth と dashboard で Origin 検証の基準が異なる**点にも注意する。
4. **RP への告知内容が確定しない。** Discovery の `issuer` は RP 側に設定される値であり、後から変えると全 RP の再設定が必要になる。**Issuer は一度公開したら変えられないものとして扱う。**
5. **Passkey が移行できない。** WebAuthn の Credential は `RP_ID` に紐づく。`RP_ID` を後から変えると、登録済みの全 Passkey が使えなくなる。ドメインを仮決めで公開してはならない。

### 8.2 メール送信プロバイダの選定（仕様書 14-3）

**現状**: `ConsoleEmailSender` のみ。`container.ts` は `ENVIRONMENT !== "development"` で例外を投げる。`EMAIL_API_KEY` という Secret 名は決まっているが、読むコードがない。

**止めている運用判断**:

1. **本番で auth-worker が起動できない。** 1.5 のとおり、`ENVIRONMENT` を正しく設定した瞬間、コンテナ生成が例外を投げて全リクエストが 500 になる。**プロバイダ実装なしに本番環境を名乗ることが構造的に不可能になっている。** これは安全側の設計だが、ブロッカーであることに変わりはない。
2. **到達性の監視手順が書けない。** バウンス率・遅延・ブロックの監視はプロバイダ固有である。「OTP が届かない」という問い合わせへの調査手順（プロバイダのダッシュボードで何を見るか、どのログに相関 ID が出るか）が本書に書けない。
3. **OTP 障害時のエスカレーション先が決まらない。** メールが止まると、Passkey を持たないユーザーは完全にログインできなくなる。プロバイダ障害時の代替手段（別プロバイダへのフェイルオーバーか、障害告知のみか）を決める必要がある。
4. **Secret のローテーション手順が書けない。** API キーの無効化・再発行の手順はプロバイダ依存である。

### 8.3 Access Token を不透明トークンにするか JWT にするか（仕様書 14-5）

**現状**: 未決。`oauth_tokens` テーブルは「どちらでも失効できるように」ハッシュと状態を持つ構造になっている（`packages/db/src/schema/oauth.ts` のコメント）。

**止めている運用判断**:

1. **署名鍵漏洩時のプレイブックが 2 通りある。** §5.1 で両方を書かざるを得なかった。JWT なら鍵の撤去が無効化手段であり、不透明トークンなら DB の UPDATE で確実に止められる。**運用の確実性では不透明トークンが明確に優る。**
2. **鍵ローテーションの待ち時間が確定しない。** §4.2 ステップ 5 の「15 分」は Access Token が JWT である前提の保守的な見積もりである。不透明トークンなら、待つべきは ID Token の 5 分だけになる。
3. **`/oauth/revoke` の仕様が書けない。** 仕様書 5.2 は「サポートする Token 種別を明示」と求めている。JWT の Access Token は revoke しても `exp` までは RP 側で検証が通ってしまうため、「revoke した」と言えるかが変わる。
4. **D1 の負荷見積もりが変わる。** 不透明トークンは検証のたびに `oauth_tokens` を引くので、Access Token の検証リクエスト数ぶん D1 のクエリが増える。D1 障害時の縮退範囲（§5.4）も広がる。

### 8.4 MFA / 管理者アカウント復旧のポリシー（仕様書 14-8）

**現状**: 未決。仕様書 6.1 は「管理権限を持つアカウントへの復旧はメール OTP だけに依存させず、追加の再認証・審査を設ける」とだけ述べている。現在、`users` に管理者フラグも権限列も存在しない。

**止めている運用判断**:

1. **§5.2 の「強制再登録」を最後まで書けない。** 一般ユーザーなら「Passkey を全削除してメール OTP で復帰」で足りるが、管理権限を持つアカウントに同じ手順を適用すると、メールを掌握した攻撃者に管理権限を渡すことになる。**管理者アカウントの侵害時に何をすべきかが、現時点では書けない。**
2. **本番 Secret へのアクセス権と、アプリケーション上の管理権限の関係が定義されていない。** 本書の §5 の手順はすべて `wrangler` での DB 直接操作を前提にしており、実行には Cloudflare アカウントへのアクセスが要る。つまり現在、「アプリ上の管理者」は存在せず「インフラ管理者」しかいない。この状態を当面続けるのか、アプリ側に管理機能を作るのかで、必要な運用手順が変わる。
3. **「誰が誰を復旧してよいか」が決まらない。** 2 名承認を要求するのか、本人確認の方法は何か、記録はどこに残すのか。これらが決まらないと、復旧依頼への応対がその場の判断になる。
4. **Passkey 必須化（仕様書 14-2）と連動する。** 初回登録で Passkey を必須にするなら復旧の重要度が上がり、必須にしないならメール OTP が常に生きた経路として残るため攻撃面が広い。

### 8.5 その他、本書の執筆中に判明した未決事項

仕様書 14 に挙がっていないが、運用上決める必要があるもの。

1. **バックアップの実行頻度と自動化手段**（§6.3）。現在エクスポートは完全に手動であり、スケジュール実行の仕組みが存在しない。
2. **`audit_logs` およびセッション行の保持期間**（§7.2）。削除バッチが存在せず、現在は無期限に増える。
3. **`ip_hash` の保持期間**（§7.3）。
4. **削除済みメールアドレスの再利用可否**（§7.1 手順 7）。`lower()` 式の UNIQUE インデックスにより、現状では再登録できない。
5. **`IP_HASH_PEPPER` のローテーション方式**（§2.4.2 / §7.3）。未設定の検知は `container.ts` のハードフェイルで解決済みだが、pepper を世代管理する仕組みがないため、変更すると過去の `ip_hash` がすべて照合不能になる。
6. **`signing_key_metadata` と `SIGNING_KEY_JWK` の整合を検証する手段**（§4.1 制約 3）。DB と Secret が食い違っても誰も気づかない。`/health` のチェック項目に「現役 kid と `SIGNING_KEY_KID` の一致」を加えるのが安価な対策である。
7. **dashboard-worker の `/health` に RPC 疎通チェックを入れるか**（§3.3.2）。現在は常に 200 を返すため、監視として機能しない。
8. **`/health` を公開したままにするか**（§5.3）。認証なしで D1 にクエリを打つ唯一の公開 endpoint である。
9. **`compatibility_date` を仕様書の 2026-10-24 へ揃える時期**（§1.1）。現在はテストツールチェーンの制約で 2026-08-15 に据え置かれている。

---

## 付録 A. よく使うコマンド

すべてリポジトリルート `/Users/tanahiro2010/Documents/proj/teams/under18dev/services` からの実行を前提とする。

```bash
# 開発
pnpm dev                      # auth-worker をローカル起動
pnpm dev:dashboard            # dashboard-worker をローカル起動
pnpm typecheck                # 全パッケージの型検査
pnpm test                     # 全パッケージのテスト
pnpm lint                     # ESLint
pnpm format                   # Prettier
pnpm build                    # 全 Worker のビルド（deploy --dry-run）
pnpm cf-typegen               # wrangler.jsonc から Env 型を再生成

# マイグレーション
pnpm db:generate              # packages/db/drizzle へ SQL を生成
pnpm db:migrate:local         # ローカル D1 へ適用
pnpm db:migrate:remote        # 本番 D1 へ適用
```

auth-worker ディレクトリ（`apps/auth-worker`）での実行:

```bash
npx wrangler deploy                                    # デプロイ
npx wrangler deployments list                          # デプロイ履歴
npx wrangler rollback                                  # 直前のバージョンへ戻す
npx wrangler tail u18-auth --format pretty             # ログ
npx wrangler secret list                               # Secret 名の一覧
npx wrangler secret put <NAME>                         # Secret の設定
npx wrangler d1 info u18-identity                      # D1 の状態とサイズ
npx wrangler d1 insights u18-identity                  # クエリの統計
npx wrangler d1 migrations list u18-identity --remote  # 未適用マイグレーション
npx wrangler d1 time-travel info u18-identity          # 現在のブックマーク
npx wrangler d1 execute u18-identity --remote --command "<SQL>"
npx wrangler d1 export u18-identity --remote --output <PATH>
```

## 付録 B. SQL を書くときの注意

1. **時刻はすべて epoch ミリ秒の INTEGER である**（`packages/db/src/schema/_shared.ts`）。SQLite の `unixepoch()` は**秒**を返すので、必ず `* 1000` する。忘れると 1970 年として記録される。
2. 読むときは逆に `/1000` してから `datetime(..., 'unixepoch')` に渡す。

   ```sql
   select datetime(created_at/1000, 'unixepoch') from sessions;
   ```

3. **真偽値は INTEGER の 0 / 1 である。** `email_verified = true` は SQLite では期待どおりに動かないことがある。`= 1` を使う。
4. `--remote` を付け忘れると、ローカルの `.wrangler/state` 内の D1 を操作する。本番を触ったつもりで何も起きていない、という事故が起きる。
5. 一括 UPDATE / DELETE の前に、必ず同じ `where` 句で `select count(*)` を実行して件数を確認する。
6. 一括操作の前に `wrangler d1 time-travel info` でブックマークを取る（§6.2）。
7. **`users` の行を消すと、`user_emails` / `passkeys` / `webauthn_challenges` / `email_challenges` / `sessions` / `oauth_authorization_codes` / `oauth_grants` / `oauth_tokens` が連鎖削除される**（外部キーの `onDelete: cascade`）。`audit_logs` は連鎖しない。
