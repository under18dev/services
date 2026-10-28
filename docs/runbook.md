# u18 Identity — 運用ランブック

- Status: Draft
- Version: 0.1.0
- Date: 2026-10-24
- 対象: `apps/auth-worker` / `apps/dashboard-worker`
- 前提仕様書: `docs/u18-identity-spec.md`

## 0. このドキュメントの読み方

本書は、コードを書いていない担当者が深夜に障害対応するために読む手順書である。各節は上から順に実行できる番号付き手順として書く。

**現状は Phase 1（仕様書 12）のスケルトンである。** 以下は未実装であり、手順を最後まで書けない箇所はその都度「Phase N で実装」と明記する。

| 機能                                                                        | 現状                                                      | 実装箇所                                                       |
| --------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| `/health`、`/api/me`、`/api/me/sessions`（GET / DELETE）                    | 実装済み                                                  | `apps/auth-worker/src/presentation/http/`                      |
| `IdentityRPC`（getSession / getUserProfile / listSessions / revokeSession） | 実装済み                                                  | `apps/auth-worker/src/presentation/rpc/identity.entrypoint.ts` |
| `/.well-known/openid-configuration`                                         | 静的に応答する                                            | `apps/auth-worker/src/presentation/http/oauth.routes.ts`       |
| `/.well-known/jwks.json`                                                    | `signing_key_metadata` から公開鍵を返す（#14。§9.5）      | 同上                                                           |
| `/oauth/authorize`、`/oauth/token`、`/oauth/userinfo`、`/oauth/revoke`      | **501 を返す**（Phase 2）                                 | 同上                                                           |
| メール OTP、Passkey、ログアウト                                             | **501 を返す**（Phase 1 の残り）                          | `apps/auth-worker/src/presentation/http/auth.routes.ts`        |
| `PATCH /api/me`                                                             | **501 を返す**                                            | `apps/auth-worker/src/presentation/http/me.routes.ts`          |
| マイグレーション SQL                                                        | **1 本も生成されていない**（`packages/db/drizzle/` は空） | `packages/db/src/schema/`                                      |

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
| compatibility_date  | 2026-10-24                        | 2026-10-24                             |
| compatibility_flags | `nodejs_compat`                   | `nodejs_compat`                        |
| observability       | 有効                              | 有効                                   |

`compatibility_date` は仕様書の日付（`2026-10-24`）に揃えてある（#108）。3 つの Worker で同じ値にすること —— ずれると「dev では動くが別の Worker では挙動が違う」が起きる。

**上げるときは必ず `pnpm test` を通してから。** テストが使う workerd が知らない日付を指定すると、テストが 1 件も実行されず `ERR_FUTURE_COMPATIBILITY_DATE` で全滅する。`wrangler dev` と `wrangler deploy` は通ってしまうので気づきにくい。

**上限は workerd のビルド日ではない。** 実測では `1.20261019.1`（2026-10-19 ビルド）が `2026-10-24` を受け付け、`2026-11-15` で落ちる。どこまで通るかは実際に走らせないと分からない。

#### Cron は 2 本ある

| Worker     | 式             | 何を掃除するか                         |
| ---------- | -------------- | -------------------------------------- |
| `u18-auth` | `*/15 * * * *` | `u18-identity` の 5 テーブル（§7.0）   |
| `u18-nfc`  | `17 * * * *`   | `u18-nfc` の `nfc_card_events`（§7.0） |

**1 本にまとめられない。** D1 の binding を持つのはそれぞれの所有者だけで、auth-worker は `u18-nfc` を読めない（§1.3）。「掃除の入口は 1 本」という原則は **D1 ごと**に適用される。

止まっていないかはログで見る。どちらも 0 件のときも出す:

```bash
npx wrangler tail u18-auth-production --format json --search "retention sweep"
npx wrangler tail u18-nfc-production  --format json --search "nfc.retention.sweep"
```

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

| Secret              | Worker | 用途                                                    | 漏洩時の影響範囲（blast radius）                                                                                                                                                                                                                           |
| ------------------- | ------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIGNING_KEY_JWK`   | auth   | ID Token 署名用 ES256 秘密鍵（JWK JSON）                | **最大**。任意の `sub` / `aud` を名乗る ID Token を偽造でき、u18 の全 RP に任意ユーザーとしてログインできる。RP 側は署名が通るので検出できない。§5.1 の緊急ローテーション対象                                                                              |
| `SIGNING_KEY_KID`   | auth   | 上記鍵の kid                                            | 単体では機密でない（JWKS で公開される値）。ただし `SIGNING_KEY_JWK` と不一致になると全 ID Token が RP 側で検証不能になる                                                                                                                                   |
| `IP_HASH_PEPPER`    | auth   | `sessions.ip_hash` / `audit_logs.ip_hash` を作る pepper | **中**。DB ダンプと併せて漏れると、IPv4 空間（約 43 億）は総当たり可能なので全ユーザーの接続元 IP が復元される。未成年ユーザーの位置情報に相当する（仕様書 9 Privacy）                                                                                     |
| ~~`EMAIL_API_KEY`~~ | auth   | （廃止）                                                | **不要になった。** #35 でメール送信は Cloudflare Email Sending の `send_email` バインディング経由と決まり、API キーを持たない設計になった（仕様書 §14.1 決定 3）。この Secret は設定しないこと —— 存在するだけで「どこかが読んでいるはず」という誤解を生む |

### 1.5 `ENVIRONMENT` が支配する分岐 — 本番デプロイ前に必ず読む

`ENVIRONMENT` は単なるラベルではなく、4 箇所の挙動を切り替える。うち 2 つは安全装置であり、設定を誤ると無言で外れる。

1. **メール送信**（`apps/auth-worker/src/composition/container.ts`）
   `EMAIL` バインディングがあれば `CloudflareEmailSender` を使う（両 `wrangler.jsonc` が `send_email` を定義しているので通常はこちら）。バインディングが無い場合、`development` なら `ConsoleEmailSender`、それ以外なら `UnconfiguredEmailSender` に落ちる。

   > **以前ここには「`development` 以外では起動時に throw され全リクエストが 500 になる」と書いてあった。#53 で解消済みである。** 組み立てで throw すると `/health` も Discovery も巻き込まれて落ちるため、現在は**失敗を送信時点まで遅らせる**。設定漏れが無関係なエンドポイントまで止めることはもう無い。代わりに「OTP を送ろうとしたときだけ失敗する」ので、**設定漏れは `/health` では検知できない**点に注意する。

2. **`IP_HASH_PEPPER` の未設定チェック**（同ファイル）
   `development` では未設定なら `"dev-pepper"` にフォールバックする。`development` 以外では `UnconfiguredIpHasher` が選ばれ、**ハッシュ化しようとした時点で** `IP_HASH_PEPPER is not set outside development` を投げる。静かに既知の pepper へ落ちて匿名化が無言で壊れるより、失敗させる方を選んである。

   > **以前ここには「全リクエストが 500 になる」と書いてあった。メール送信と同じく #53 で解消済みである。** 現在落ちるのは **IP をハッシュ化する経路だけ**で、具体的には `IssueSessionUseCase`（セッション発行）とレート制限の鍵の算出である。**監査ログは落ちない** —— `RequestScopedAuditLogger` がハッシュ化の失敗を飲み込み、`ip_hash` を空にしてイベントだけ記録する（#122）。監査のためだけの計算が認証経路を道連れにしないため。設定漏れはログイン時に表面化し、`/health` では検知できない。

3. **セッション Cookie**（`packages/contracts/src/session-cookie.ts` の `sessionCookieName()`）
   `development` では `u18_session`（`Secure` なし）、それ以外では `__Host-u18_session`（`Secure` 付き）になる。この名前は auth-worker と dashboard-worker が **契約パッケージ経由で共有**しており、どちらか片方だけが別名を見ることはない。
4. **ヘルス応答**：~~`/health` のボディに `environment` をそのまま出す~~ —— **出さなくなった**（脅威モデル RR-18）。`ENVIRONMENT` の取り違えは Discovery の `issuer` で検知する。

#### `--env production` を付け忘れると安全装置がまとめて外れる

> **この節は書き換えられている。** 以前は「両 Worker とも `env.production` セクションを持たない」と書かれていたが、**現在は両方とも持っている**（#42 / #33）。危険の所在が「env が無いこと」から「`--env` を付け忘れること」へ移った。

両 `wrangler.jsonc` は `env.production` を持ち、`ENVIRONMENT` / `ISSUER` / `RP_ID` / `WEBAUTHN_ORIGIN` / `EMAIL_FROM` を本番値で上書きする。**したがってデプロイは必ず `--env production` を付ける。**

付け忘れると既定の `vars`（`ENVIRONMENT: "development"`、`ISSUER: "http://localhost:8787"`）がそのまま本番 Worker に乗る。結果:

- `IP_HASH_PEPPER` 未設定のハードフェイルが働かず、IP ハッシュが公開された既定 pepper `"dev-pepper"` で計算される。
- Cookie が `__Host-` 接頭辞も `Secure` も付かない状態で発行される。
- Discovery が `http://localhost:8787` を Issuer として広告する。
- Worker 名が `u18-auth`（`-production` が付かない）になり、**dashboard-worker の Service Binding が指す `u18-auth-production` と食い違う**。

既定値が安全側ではないのは意図的で、「development を明示的に上書きしないと本番にならない」より「本番を明示しないと development のまま」の方が、設定漏れが目に見える形で壊れるためである。

**CI はこれを機械的に止める。** `.github/workflows/deploy.yml` の preflight は `wrangler.jsonc` に `REPLACE_WITH_` が 1 つでも残っていればデプロイを中止し、残っている件数と該当行を出す（#80）。デプロイ後は **Discovery の `issuer` が本番の値である**ことをスモークテストが検証する（#66 / RR-18）—— **ステータスコードだけ見る検査は `--env` の付け忘れを素通りさせる**ため、本文まで見ている。付け忘れると `ENVIRONMENT` と一緒に `ISSUER` も既定値（`http://localhost:8787`）のまま乗るので、`issuer` を突き合わせれば同じ間違いを捕まえられる。

現在 `REPLACE_WITH_D1_DATABASE_ID` が残っているので、**preflight は意図的にデプロイをブロックしている**（#5）。これは障害ではなくガードが働いている状態である。

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

#### `database_id` を変えると、各自のローカル D1 が別実体になる

**この行を書き換えた時点で、手元の `--local` D1 は「別のデータベース」になる。** miniflare はローカルの状態を `database_id` ごとに分けて持つため、新しい ID に対応する実体は空である。

症状はこう出る。

```
✘ [ERROR] no such table: oauth_clients: SQLITE_ERROR
```

マイグレーションを適用し忘れたときと同じメッセージなので、**原因が `database_id` の変更だと気づきにくい。** 実際、本番 D1 を払い出して `REPLACE_WITH_` を実値へ置き換えた直後に、各セッションの手元がこの状態になった。

復旧は作り直すだけでよい（ローカルの中身は開発用データしかない）。

```bash
pnpm db:migrate:local
pnpm --filter @u18/auth-worker key:generate --apply-local   # 署名鍵も消えている
pnpm --filter @u18/auth-worker client:seed-dev              # 必要なら開発用クライアント
```

`key:generate` をやり直すと `.dev.vars` の `SIGNING_KEY_JWK` も入れ替える必要がある。これを忘れると `/.well-known/jwks.json` が 503 を返し、ID Token も発行できない（§9.5）。

### 2.4 Secret の生成と設定

#### 2.4.1 ES256 署名鍵（`SIGNING_KEY_JWK` / `SIGNING_KEY_KID`）

独自の鍵生成コードを書かない（仕様書 5.4）。Node.js の `node:crypto` で P-256 鍵ペアを作り、JWK として書き出す。この手順はスクリプトにまとめてある。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
node scripts/signing-key.mjs generate
```

出力例:

```text
# .dev.vars に貼る（本番は wrangler secret put SIGNING_KEY_JWK で入れる）
SIGNING_KEY_JWK={"keys":[{"kty":"EC","x":"...","y":"...","crv":"P-256","d":"...","alg":"ES256","use":"sig","kid":"u18-2026-10-24-1"}]}

# signing_key_metadata に入れる公開鍵（機密ではない）
insert into signing_key_metadata ... values ('u18-2026-10-24-1', 'ES256', '{"kty":"EC","x":"...","y":"...","crv":"P-256","alg":"ES256","use":"sig","kid":"u18-2026-10-24-1"}', ...);
```

**`SIGNING_KEY_JWK` は JWK Set（`{"keys":[...]}`）である（#23）。** 鍵を配列で持てるので、ローテーション中は新旧 2 本が 1 つの Secret に同居する。どの鍵で新規署名するかは Secret ではなく `signing_key_metadata` の `active_from` / `active_until` が決める。

**単一 JWK（`{"kty":"EC",...}`）+ `SIGNING_KEY_KID` という #23 以前の形式も、そのまま動き続ける。** 既存環境は Secret を触らなくてよい。移行するのは次にローテーションするときで、`generate` が既存の鍵を取り込んだ JWK Set を出力する（4.2 ステップ 1）。Set へ移行したら `SIGNING_KEY_KID` は参照されなくなるので削除してよい。

注意点:

- `d` を含む方が秘密鍵である。`insert` 文に入っている JWK（`d` を含まない方）は `signing_key_metadata.public_jwk` に入れる値であり、機密ではない。
- 3 つの出力を取り違えないこと。`SIGNING_KEY_JWK` に公開鍵を入れると署名時に落ちる。`public_jwk` に秘密鍵を入れると **JWKS 経由で秘密鍵を世界中に配布する**ことになる。
- この出力は端末のスクロールバッファとシェル履歴に残る。設定後に `history -c`（zsh なら `fc -p`）と画面クリアを行い、スクリーンショットも残さない。

設定:

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler secret put SIGNING_KEY_JWK   # 対話プロンプトに JWK Set の JSON を貼り付ける
```

入れる**前**に、DB 側の行と食い違っていないかを確認できる（#23）。本番の Secret は書き込み専用で読み出せないため、検査は「これから入れる値」に対して行う。

```bash
# 投入予定の値をファイルに置いて突き合わせる（ファイルは確認後に消すこと）
node scripts/signing-key.mjs verify --remote --secret-file ./new-secret.json
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

#### 2.4.3 `EMAIL_API_KEY`（廃止）

**この Secret は不要になった。設定しないこと。**

#35 でメール送信は **Cloudflare Email Sending**（`wrangler.jsonc` の `send_email` バインディング）に決まり、実装は `apps/auth-worker/src/infrastructure/email/cloudflare-email-sender.ts` にある（仕様書 §14.1 決定 3）。Worker の外へ出す認証情報を増やさずに済むのがこの選択の理由で、**API キーという概念自体が無くなった**。

送信元アドレスは Secret ではなく `vars` の `EMAIL_FROM`（本番は `noreply@under18.dev`）。**このドメインは Cloudflare 側で検証済みでなければ送信が実行時に失敗する。**

<!-- 以前ここにあった `wrangler secret put EMAIL_API_KEY` の手順は削除した。
     実行しても何も読まれず、「設定したから動くはず」という誤解だけが残るため。 -->

```bash
# 参考: 送信のシミュレーション（wrangler dev は実送信しない）
# 本文は .wrangler/tmp/email/ 配下にファイルとして出力される
```

#### 2.4.4 設定済み Secret の確認

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler secret list
```

値は表示されない。名前の一覧だけを確認する。`SIGNING_KEY_JWK` と `IP_HASH_PEPPER` が揃っていること（`SIGNING_KEY_KID` は JWK Set 形式では使われない。#23 以前から運用している環境にだけ残っている）。

**`secret list` では中身が確認できない。** 「名前はあるが中身が DB と食い違っている」状態はこのコマンドでは見えないので、2.4.1 の `verify` を使うこと。

#### 2.4.5 ローカル開発用

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
cp .dev.vars.example .dev.vars
# .dev.vars を編集し、2.4.1 / 2.4.2 で生成した「開発用の別の値」を入れる
```

`.dev.vars` は `.gitignore` 済み（`!.dev.vars.example` の例外付き）。本番の値をここに書かない。

**`.dev.vars` を書き換えたら `wrangler dev` を再起動する。** 起動時にしか読まれないため、編集しただけでは反映されない（4.5 を参照）。本番の `wrangler secret put` は再デプロイなしに反映されるので、この違いはローカルだけのものである。

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

`packages/contracts/src/version.ts` の `CONTRACT_VERSION`（現在 `1.4.0`）は semver として扱う。

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

実装は `apps/auth-worker/src/presentation/http/health.routes.ts` で、実際の疎通は `DatabaseProbe` Port（`apps/auth-worker/src/application/ports/health.port.ts`）の実装である `apps/auth-worker/src/infrastructure/persistence/drizzle-database-probe.ts` が行う。

**HTTP ステータスを決めるのは `checks.database` だけである。** `checks` には署名鍵の状態も出るが（下記）、そちらは**値として読むだけ**で、200 / 503 の判断には一切入らない。理由は 4.4 にある。この分離は意図的なので、監視を増やすときにここを結び付け直さないこと。

```bash
curl -i https://<auth-worker-の-URL>/health
```

| 観測                                                                      | 意味                                                                                                                                                 | 対応                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| HTTP 200、`{"status":"ok","checks":{"database":"ok","signingKey":"ok"}}`  | Worker が動き、D1 binding 越しにクエリが通った                                                                                                       | 正常                                |
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

##### `checks.signingKey`

`signing_key_metadata` と `SIGNING_KEY_JWK` が食い違っていないかを外から見るための項目である（4.1 制約 3 / 4.4）。**この値がどうであれ HTTP ステータスは変わらない。**

| 値              | 意味                                                     | 症状                                                                               | 対応                                         |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------- |
| `ok`            | 現役の kid が Secret にあり、JWKS にも出ている           | 正常                                                                               | —                                            |
| `unavailable`   | 現役の kid が Secret に無い（署名できない）              | **`/oauth/token` が ID Token を出せない。** 新規ログインだけが止まる               | `pnpm key:verify` で理由を見る → 4.2         |
| `not_published` | Secret にはあるが JWKS に出ていない（RP が検証できない） | **全 RP で一斉に検証失敗。auth-worker のログには何も出ない**（署名は成功している） | `signing_key_metadata.public_jwk` の行を直す |

`not_published` は `unavailable` より見つけにくい。署名は通るので auth-worker 側は「成功した」としか記録せず、気づくのは RP からの問い合わせになる。**この 2 つを 1 つの真偽値に畳まないこと**（畳むと、`/health` を見た後に結局 `verify` を実行して原因を調べ直すことになる）。

鍵をまだ一度も設定していない環境（Phase 1 相当の構成、プレビュー）では `unavailable` が正常な値である。OIDC を使っていないなら直す必要はない。

応答に **kid は出ない。** 未認証で叩ける endpoint から鍵の識別子が見えて運用者が得るものが無いため。どの kid の話かは `pnpm key:list` / `pnpm key:verify` で見る。

#### 3.3.2 dashboard-worker の `/health`

```bash
curl -i https://auth.under18.dev/account/health
```

**パスは `/account/health` である**（#106）。dashboard-worker の本番 route は `auth.under18.dev/account/*` で、Cloudflare は一致した接頭辞を URL から取り除かない。`/health` を叩くと auth-worker の `auth.under18.dev/*` に吸われ、**auth-worker の health が返る**ので気づきにくい。接頭辞は `apps/dashboard-worker/src/base-path.ts` の `ACCOUNT_BASE_PATH` に定数として置いてある。

**この endpoint は `IDENTITY` Service Binding の疎通まで確かめる**（#44 で修正済み）。`IdentityRPC.ping()` を呼び、結果を `checks.identity` として返す。

| `checks.identity` | 意味                                                               | HTTP |
| ----------------- | ------------------------------------------------------------------ | ---- |
| `ok`              | auth-worker に届き、auth-worker も D1 へ届いている                 | 200  |
| `degraded`        | auth-worker は生きているが D1 へ届いていない                       | 503  |
| `unreachable`     | Binding が切れている / auth-worker が落ちている / 2 秒で応答しない | 503  |

したがって:

- **外形監視の合否判定に使ってよい。** 以前（#44 修正前）は固定の JSON を返すだけで、auth-worker が完全に落ちていても緑になった。その頃の手順書を読んでいる場合は注意すること。
- `ping()` は認証を要さず、識別子も件数も返さない。応答に機密情報は含まれない。
- 待ち時間の上限は 2 秒（`identity.gateway.ts` の `PING_TIMEOUT_MS`）。auth-worker の遅延が dashboard の `/health` の遅延になると、監視から「落ちている」と「遅い」の区別が消えるため。
- dashboard-worker 側で RPC 障害を見たい場合は、Workers のログで `identity_unavailable` を検索する（`apps/dashboard-worker/src/infrastructure/rpc/identity.gateway.ts` がこの値に翻訳している）。

  ```bash
  cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/dashboard-worker
  npx wrangler tail u18-dashboard --format pretty --status error
  ```

#### 3.3.3 監査ログの書き込み失敗をアラートにする

**監査ログは「書けなかったこと」に気づけないと意味を失う。** 書き込み失敗は握り潰して認証を通す設計なので（`AuditLogger.record()` の契約。`architecture.md` §4.1）、**失敗しても利用者にも運用者にも何も起きない。** 気づくのは侵害調査で「この期間だけログが無い」と分かった時になる。

##### 何を引くか

`drizzle-audit-logger.ts` が 1 行の JSON を `console.error` に出す。

```json
{ "event": "audit_log.write_failed", "auditEvent": "otp.verify", "reason": "Error" }
```

**照合キーは `audit_log.write_failed` の文字列。** 可読メッセージの部分一致ではなく、この値で引く。コード側は `AUDIT_WRITE_FAILED` という定数で持ち、`test/audit-logger.test.ts` が**値そのものを固定**している —— 変えるとテストが落ちるので、Cloudflare 側の設定を直し忘れることはない。

`auditEvent` には書けなかったイベント名が入る。どの経路が落ちているかの手掛かりになる。**`metadata` と例外のメッセージは載せていない** —— 失敗したときだけ秘密がログへ出る形を避けるため（D1 の例外は失敗したクエリを含むことがある）。

##### 設定手順

`observability.enabled: true` なので Workers Logs に入っている。手で見るなら:

```bash
cd apps/auth-worker
npx wrangler tail u18-auth-production --format json --search "audit_log.write_failed"
```

**常設のアラートはダッシュボードで設定する**（API トークン経由でも可）。

1. Cloudflare ダッシュボード → **Notifications** → **Add**
2. 製品に **Workers** を選び、**Workers Logs Alert**（アカウントのプランに依存）
3. 対象 Worker: `u18-auth-production`
4. 条件: ログに `audit_log.write_failed` を含む行が **5 分間に 1 件以上**
5. 宛先: 運営の連絡先

> **閾値を「1 件以上」にする理由。** 監査ログの書き込みは認証のたびに走るので、恒常的に失敗していれば件数は多い。逆に**1 件しか出ない失敗**（特定のイベントだけ落ちる、`metadata` が大きすぎる等）のほうが見逃しやすく、かつ調査で効いてくる。ノイズになるようなら閾値ではなく**原因を直す**こと。

##### アラートが設定できない場合

プランの都合で Workers Logs Alert が使えないときは、**代わりに定期確認を運用に入れる**。自動化されていないことを明示して記録する:

```bash
# 直近 24 時間に書き込み失敗が出ていないか
npx wrangler tail u18-auth-production --format json --search "audit_log.write_failed"
```

**「手順を書いた」と「設定した」は別である。** 設定したかどうかは §12.6 のチェックリストで追う。

#### 3.3.4 ログの見方

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler tail u18-auth --format pretty
npx wrangler tail u18-auth --format json --status error
npx wrangler tail u18-auth --search "database probe failed"
npx wrangler tail u18-auth --search "audit_log.write_failed"
```

両 Worker とも `observability.enabled: true` なので、Cloudflare ダッシュボードの Workers Logs からも過去分を検索できる。

ログに現れる代表的なメッセージ:

| メッセージ                                                          | 出所                        | 意味                                                                                                                                                |
| ------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database probe failed`                                             | `drizzle-database-probe.ts` | D1 への `select 1` が失敗した。`/health` が 503 を返している                                                                                        |
| `unhandled error`                                                   | `app.ts` の `onError`       | 捕捉されなかった例外。詳細はクライアントへ返していない                                                                                              |
| `{"event":"audit_log.write_failed",…}`                              | `drizzle-audit-logger.ts`   | 監査ログの書き込みが失敗した。**認証自体は成功している。** 監査の欠落として扱う（§3.3.3）                                                           |
| `EMAIL_PROVIDER is not configured for non-development environments` | `container.ts`              | §1.5 参照。`ENVIRONMENT` 設定ミスかメールプロバイダ未実装                                                                                           |
| `IP_HASH_PEPPER is not set outside development`                     | `container.ts`              | §1.5 / §2.4.2 参照。Secret 未設定のまま非 development で起動した                                                                                    |
| `[dev] OTP for ...`                                                 | `console-email-sender.ts`   | **本番でこれが出ていたら重大インシデント。** OTP が平文でログに記録されている。直ちに §5.3 相当の対応（`ENVIRONMENT` の是正とログの削除依頼）を行う |

ログに Cookie・セッショントークン・OTP・生 IP を出力するコードを追加してはならない（仕様書 4.4 / 9）。

---

### 3.4 依存の脆弱性で CI が落ちたとき

`.github/workflows/security.yml` の `audit` ジョブは 2 段構えになっている。

| ステップ                               | コマンド                               | CI を落とすか                     |
| -------------------------------------- | -------------------------------------- | --------------------------------- |
| Audit production dependencies          | `pnpm audit --prod --audit-level high` | **落とす**                        |
| Audit dev dependencies (informational) | `pnpm audit --audit-level high`        | 落とさない（`continue-on-error`） |

Worker にバンドルされるのは production 依存だけなので、**本番に到達しうる high 以上はブロックする**。dev 依存は実行時に載らないため可視化にとどめる。

このジョブは依存ツリーではなく**外部のアドバイザリ DB の状態で結果が変わる**。production 依存に新しい high が 1 件載った瞬間、開いているすべての PR と `main` への push、週次実行が同時に赤くなる。**赤くなった PR の作者から見ると、自分の変更と無関係なジョブが落ちている状態になる。** そのときの手順を以下に示す。

#### ステップ 1 — どちらのステップが落ちたか切り分ける

```sh
# これが落ちていれば本番に到達しうる。対応が要る
pnpm audit --prod --audit-level high

# こちらだけが鳴っている場合、CI は落ちていない（informational）
pnpm audit --audit-level high
```

`--prod` がクリーンなら、その PR は CI 的にはブロックされていない。

#### ステップ 2 — その PR の変更が原因かを判定する

ほぼの場合、原因は PR ではなくアドバイザリの新規公開である。判定は次で足りる。

```sh
# PR のブランチで落ちるか
pnpm audit --prod --audit-level high

# main でも落ちるか
git stash && git checkout main && pnpm install --frozen-lockfile
pnpm audit --prod --audit-level high
```

**`main` でも落ちるなら、その PR の責任ではない。** PR にその旨をコメントし、対応は下記の経路で別途行う。PR 側で無理に直さない。

該当パッケージがどこから来ているかは次で辿る。

```sh
pnpm why <package-name>
```

#### ステップ 3 — 対処を選ぶ

上から順に検討する。

**(a) 依存をバンプする — 第一選択**

直接依存なら `package.json` を更新する。Dependabot の PR が既に出ていることも多いので、先に確認する。

**(b) 推移的依存なら `pnpm.overrides` でパッチ版へ固定する**

直接依存していないパッケージは自分で上げられない。ワークスペースのルート `package.json` に書く。ルートに書けば全ワークスペースへ効く。

```jsonc
{
  "pnpm": {
    "overrides": {
      "<package-name>": ">=<patched-version>",
    },
  },
}
```

適用後は必ず `pnpm install` と `pnpm test` を通す。override は上流が正式対応したら**外す**。外し忘れると、将来の正規のバンプを黙って抑止する。

**(c) 影響が無いと判断して一時的に除外する — 最後の手段**

Worker にバンドルされない経路であることが確認できた場合に限る。**理由と見直し期限を必ず書き残す。無期限の除外を作らない。** 期限付きの issue を立て、`security` ラベルを付けて追跡する。

#### やってはいけないこと

次の変更は、production 依存の high を恒久的に見逃す設定になる。**認証基盤では受け入れない。**

- `--audit-level` を `critical` へ引き上げる
- production 側のステップから `--prod` を外す、またはステップごと削除する
- production 側のステップに `continue-on-error: true` を足す

いずれも「いま鳴っている音を止める」ことはできるが、一度外すと戻らない。鳴っているアラート 1 件より、鳴らなくなったゲートのほうが危険である。

#### 既知の罠 — pool-workers を上げて黙らせない

現在、`pnpm audit`（dev 含む）の high はすべて `@cloudflare/vitest-plugin` 配下の推移的依存（`zod`）である。これらは informational 側なので **CI は落ちていない**。`vitest-plugin@1.4.7` が `zod@4.6.5` を固定しており、修正版は `>=4.6.6`。**プラグイン側が上げるまで消えない。**

ここで「まとめて消そう」と `@cloudflare/vitest-plugin` を上げると、同梱される workerd が動き、`wrangler.jsonc` の `compatibility_date`（`2026-10-24`）との整合が崩れうる。結果、テストが 1 件も実行されず起動時に全滅する。

```
MiniflareCoreError: ERR_FUTURE_COMPATIBILITY_DATE
```

厄介なのは見え方で、`wrangler dev` は動き続けるためバンプと無関係な破損に見える。`compatibility_date` と同時に見直すこと。詳細は #24、Dependabot 側では `cloudflare-workers-runtime` グループで単独バンプを抑止している。

#### 対応が長期化する場合

上流にパッチが無く `pnpm.overrides` も当てられない場合、**ゲートを緩めるのではなく issue を立てて追跡する**。記録すべき内容は、アドバイザリ ID、影響する経路（`pnpm why` の出力）、本番バンドルに届くか、暫定の緩和策、再評価の期日。

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

1. ~~**JWKS endpoint（`/.well-known/jwks.json`）は未実装で 501 を返す。**~~ #14 で実装済み。JWKS は `signing_key_metadata` を正本として読み、`retires_at` を迎えていない鍵を**すべて**返す（`active_until` が過去の鍵も含む）。以下の手順はそのまま実行できる。ただし ID Token を実際に発行できるのは `/oauth/token` の実装後なので、ステップ 6 の確認だけは Phase 2 の残りを待つ。
2. ~~**`SIGNING_KEY_JWK` は単一の Secret であり、秘密鍵は一度に 1 本しか持てない。**~~ #23 で解消済み。`SIGNING_KEY_JWK` は **JWK Set（`{"keys":[...]}`）** を受け付け、新旧 2 本を同居させられる。
3. ~~**`signing_key_metadata` の行と Secret の中身が一致しているかを検証する仕組みがない。**~~ #23 で解消済み。`node scripts/signing-key.mjs verify` が突き合わせる。

**この 2 つが解消されたことで、ローテーションの性質が変わっている。**

鍵の切り替えは、もはや Secret の置き換えではない。**どの鍵で新規署名するかを決めるのは `signing_key_metadata` の `active_from` / `active_until` だけ**で、Secret は「手元に持っている鍵の束」でしかない（`apps/auth-worker/src/domain/services/signing-key-rotation.ts`）。したがって手順は次の形になる。

| 操作                 | 何で行うか             | 可逆か                           |
| -------------------- | ---------------------- | -------------------------------- |
| 鍵を足す / 外す      | `wrangler secret put`  | いつでもよい。署名鍵は変わらない |
| **署名を切り替える** | **D1 の UPDATE 1 回**  | UPDATE を戻せば戻る              |
| JWKS から外す        | `retires_at` の UPDATE | 戻せる（DELETE するまで）        |

旧実装では `SIGNING_KEY_JWK` と `SIGNING_KEY_KID` の 2 本を「数秒以内に」更新する必要があり、その間に発行された ID Token は「旧 kid を名乗る新鍵署名」になって全 RP で検証に失敗した。Secret を束にしたことで、**その窓が構造的に無くなった**。`SIGNING_KEY_KID` を足し忘れる・消し忘れる類の事故も起きない（Set 形式では参照されない）。

**残っている前提**: Secret と DB は依然として別々に更新される。両者が食い違っていないかは `verify` で確認する。確認は自動では走らない —— `/health` には入れていない（理由は 4.4）。

### 4.2 定期ローテーション手順

実行の目安: 90 日ごと、または鍵に触れる権限を持つメンバーが離脱したとき。

所要時間の実質は待ち時間であり、作業そのものは 30 分程度。

#### ステップ 1 — 新しい鍵ペアを生成する

`kid` は日付入りにして、既存の kid と衝突しないようにする（既定でそうなる）。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
node scripts/signing-key.mjs generate
```

出力は 2 つに分かれる。

- `SIGNING_KEY_JWK=` の行 —— 秘密鍵（`d` 入り）。ステップ 4 で Secret に入れる。
- `insert into signing_key_metadata ...` —— 公開鍵。ステップ 2 で登録する。

秘密鍵は、この後 Secret に入れるまでの間、安全な場所に一時的に置く。

**この出力の JWK Set には新しい鍵しか入っていない。** 本番の現行 Secret は読み出せないため、スクリプトは現行の鍵を知らない。ステップ 4 で `wrangler secret put` するときは、**手元に控えてある現行の鍵と新しい鍵の 2 本**を並べた Set にすること。

```json
{ "keys": [ { "kid": "<旧 kid>", "d": "...", ... }, { "kid": "<新 kid>", "d": "...", ... } ] }
```

現行の鍵の控えが無い場合は、この時点でローテーションを止めない —— 旧鍵を Set に入れられなくても、`active_until` を過ぎた旧鍵は**署名にはもう使わない**ので実害は無い。失うのは「新鍵に問題が出たとき旧鍵へ戻す」選択肢だけである。ロールバックの余地を残したいなら、控えが無い時点で記録の運用（ステップ 9）を先に直すこと。

#### ステップ 2 — 新しい公開鍵を JWKS に先行公開する

`signing_key_metadata` に新しい kid の行を入れる。ただし **`active_from` を未来に置く** ことで、「JWKS には載るが、まだ署名には使わない」状態を作る。`register` の既定がこの先行公開（24 時間後）である。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
node scripts/signing-key.mjs register \
  --kid u18-2026-10-24-1 \
  --public-jwk '<generate が出した公開 JWK>' \
  --remote
```

`--public-jwk @path.json` でファイルからも読める。`--active-in 48h` のように先行公開の長さを変えられる。`--dry-run` を付けると SQL を表示するだけで実行しない。

**`register` が手書き SQL より安全な点**:

- 時刻列は **epoch ミリ秒の INTEGER** である（`packages/db/src/schema/_shared.ts` の `timestampMs`）。SQLite の `unixepoch()` は秒を返すので 1000 倍が要る。これを忘れると 1970 年として解釈され、鍵のライフサイクル判定が全部狂う。スクリプトが常に 1000 倍する。
- `--public-jwk` に `d` を含む JWK（＝秘密鍵）を渡すと**拒否する**。手書きの INSERT にはこの関門が無く、取り違えると JWKS 経由で秘密鍵を配ることになる。
- 既に同じ kid の行があれば止まる。

確認:

```bash
node scripts/signing-key.mjs list --remote
curl -s https://<auth-worker-の-URL>/.well-known/jwks.json | jq '.keys[].kid'
```

`list` は各鍵が「署名中 / 先行公開 / 署名停止 / 撤去済み」のどれかを、Worker と同じ判定（`signingKeyState`）で表示する。

**この待ちが必要な理由**: RP（Relying Party）は JWKS をキャッシュする。キャッシュ期間中に未知の `kid` を持つ ID Token が届くと、RP の実装によっては JWKS を再取得せずそのまま検証失敗にする。新しい公開鍵を**先に**配っておくことで、署名を切り替えた瞬間に全 RP が既に新しい鍵を持っている状態を作る。

#### ステップ 3 — JWKS キャッシュが行き渡るのを待つ

**24 時間待つ。**

- RP 側の JWKS キャッシュ TTL は u18 からは制御できない。一般的な OIDC ライブラリの既定値は 5 分から 24 時間まで幅がある。
- この待ちは「最長の JWKS キャッシュ TTL」を見込んだものであり、トークンの寿命とは無関係である。
- 緊急時（§5.1）はこの待ちを省略する。その代償は「JWKS を再取得しない RP で一時的に検証失敗が出る」ことである。
- 待っている間、**本番は何も変わっていない**。`active_from` が未来なので新しい鍵は署名に使われず、JWKS に 1 本増えるだけである。ここで中止するなら、行を DELETE すれば元に戻る。

#### ステップ 4 — 署名を新しい kid へ切り替える

**順序が逆になった（#23）。先に Secret、後で切り替えである。**

まず Secret に新旧 2 本を入れる。この時点では**署名鍵は変わらない**（新鍵の `active_from` がまだ未来のため）。Secret の更新は Worker の再デプロイなしに反映される。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler secret put SIGNING_KEY_JWK   # ステップ 1 で作った「旧 + 新」の JWK Set
```

**何も起きないことを確認してから進む。** 投入した値と DB の突き合わせはこれで行う。

```bash
node scripts/signing-key.mjs verify --remote --secret-file ./new-secret.json
```

期待する出力は「新規署名に使われる kid: <旧 kid>」と、新鍵についての `情報: ... active_from is in the future`。ここで `NG:` が出たら切り替えてはいけない。

次に署名を切り替える。**これが唯一の不可逆でない一点で、ここから新鍵で署名が始まる。**

```bash
node scripts/signing-key.mjs activate --kid <新 kid> --remote
```

`activate` は切り替える前に、**新 kid が Secret に入っていて、その公開鍵が `signing_key_metadata` の行と一致していること**を確かめる（本番 Secret は読めないので `--secret-file` か環境変数 `SIGNING_KEY_JWK` で渡す。渡さなければ警告だけ出て続行する）。一致しなければ中止する —— ここを素通りすると、UPDATE の直後から全 RP で ID Token の検証が一斉に失敗し、auth-worker 側のログには何も出ない。

`activate` が行うのは次の 3 つで、すべて 1 回の実行にまとまっている。

1. 現役の鍵（`active_until is null` かつ `active_from` が過去）の `active_until` を現在時刻にする。先行公開中の**別の**鍵は巻き込まない。
2. 新 kid の `active_from` を現在時刻へ引き下げる。
3. 監査ログ `signing_key.rotated` を `audit_logs` に記録する（どの kid へ、どの kid から切り替えたか）。

**戻したくなったら**、旧 kid へ `activate` し直せばよい。旧鍵は Secret にも JWKS にも残っている（これがステップ 1 で 2 本を Set に入れる理由）。

#### ステップ 5 — 発行済みトークンが自然に失効するのを待つ

**10 分待つ。**（#23 で 15 分から訂正。根拠は下記）

内訳（仕様書 5.3 / `apps/auth-worker/src/domain/services/token-lifetime.ts`）:

| トークン           | 寿命      |
| ------------------ | --------- |
| Authorization Code | 60 秒     |
| **ID Token**       | **5 分**  |
| **Access Token**   | **10 分** |

現在、署名鍵で保護されている最長の寿命は **ID Token の 5 分** である。#37 で **Access Token は不透明トークン**と決まった（仕様書 §14.1 決定 5）ので、Access Token は署名鍵と無関係になり、待つべき時間は ID Token の 5 分だけになった（以前は JWT の可能性を見込んで 10 分で見積もっていた）。Refresh Token は MVP では発行しない（仕様書 1.2）ので、これより長い寿命のトークンは存在しない。

**既定値の算出（#23）**:

| 項目                                   | 値        | 根拠                                    |
| -------------------------------------- | --------- | --------------------------------------- |
| 切り替え時に発行された ID Token の寿命 | 5 分      | `TokenLifetime.idTokenMs`（仕様書 5.3） |
| RP 側のクロックスキュー許容            | ~1 分     | 一般的な OIDC ライブラリの既定          |
| 処理中リクエストと操作の余裕           | ~4 分     | 切り上げ                                |
| **合計**                               | **10 分** | —                                       |

**15 分は Access Token が JWT になりうる前提の数字で、決定 5 の時点で根拠を失っていた。** 10 分へ訂正する。なお 5 分でも理屈は通るが、この待ちの代償はゼロ（待っている間 JWKS も署名鍵も変わらない）なので、短く攻める理由がない。

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

**DB と Secret の整合も確認する（#23）。**

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
node scripts/signing-key.mjs list --remote
node scripts/signing-key.mjs verify --remote --secret-file ./new-secret.json
```

`verify` が「新規署名に使われる kid: <新 kid>」と「OK:」を出すこと。この確認は kid の一致だけでなく**公開鍵の中身まで**突き合わせる。kid が合っていても鍵が別物なら、署名は成功するのに全 RP で検証が失敗する —— auth-worker のログには何も出ないので、ここで見ないと RP からの問い合わせで気付くことになる。

`verify` は Worker が署名直前に使うのと同じ判定関数を呼ぶ。「スクリプトは OK と言ったのに Worker は署名できない」は起こらない。

確認が終わったら、ステップ 1 と 4 で作った `./new-secret.json` を**消す**こと。

#### ステップ 7 — 旧鍵の `retires_at` を設定する

ステップ 5 の待ちが終わってから、旧鍵の撤去予定時刻を記録する。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
node scripts/signing-key.mjs retire --kid <旧 kid> --remote      # 既定で 7 日後
```

**猶予期間の既定は 7 日。下限は 24 時間 5 分である。**

| 要素                                  | 値               | 何を待っているか                                                 |
| ------------------------------------- | ---------------- | ---------------------------------------------------------------- |
| ID Token の最長寿命                   | 5 分             | 旧 kid で署名された発行済みトークンが自然失効するまで            |
| RP の JWKS キャッシュ（最長の見込み） | 24 時間          | 旧 kid を知っている RP がキャッシュを捨て、新 kid を取得するまで |
| **下限**                              | **24 時間 5 分** | これを下回ると、旧 kid のトークンを持つ RP が検証に失敗しうる    |
| **既定**                              | **7 日**         | 下限 + ロールバックの余地と長期キャッシュへの保険                |

`retire` は下限を下回る `--in` を**拒否する**（`--in 0 --force` で強行できる）。猶予を縮めるのは鍵漏洩への対応（§5.1）だけの判断で、事故で短くするのと意図して短くするのを区別するためにこの関門を置いている。

この期間中、旧鍵は **JWKS に載り続けるが新規署名には使われない**（`active_until` が過去なので）。現役の鍵（`active_until is null`）に `retire` しようとすると止まる —— JWKS から消えた鍵で署名し続ける状態になるため。

#### ステップ 8 — `retires_at` 到達後に JWKS から外す

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
# 撤去済みになっていることの確認（「撤去済み」と表示される）
node scripts/signing-key.mjs list --remote
# 行の削除
npx wrangler d1 execute u18-identity --remote --command "
delete from signing_key_metadata where kid = '<旧 kid>';
"
```

**このとき Secret からも旧鍵を外す。** JWK Set から該当の鍵を除いて `wrangler secret put SIGNING_KEY_JWK` し直す。残っていても署名には使われないが（行が無い、あるいは撤去済みなので Worker が拒否する）、不要になった秘密鍵を持ち続ける理由はない。`verify` は行の無い鍵が Secret に残っていることを `NG` として報告する。

**確定（#14）**: JWKS 実装は `retires_at <= now` の行を自動的に除外する（`DrizzleSigningKeyMetadataRepository.listPublishable`）。したがって**この DELETE は行の掃除にすぎず、公開状態には影響しない**。`retires_at` を過去にした時点で鍵は JWKS から消えている。逆に言えば、緊急時に鍵を即座に外す操作は DELETE ではなく `retires_at` の更新である（§5.1 はそちらを指示している）。

#### ステップ 9 — 記録

鍵の生成日・kid・切り替え日時・実行者を運用記録に残す。秘密鍵そのものは残さない。

### 4.3 待ち時間の要約

| ステップ | 待ち    | 何を待っているか                                                                |
| -------- | ------- | ------------------------------------------------------------------------------- |
| 2 → 4    | 24 時間 | RP 側の JWKS キャッシュが更新されるのを待つ                                     |
| 4 → 7    | 10 分   | 旧鍵で署名済みの ID Token（5 分）が自然失効するのを待つ（#23 で 15 分から訂正） |
| 7 → 8    | 7 日    | 長期キャッシュしている RP と、ロールバックのための保険                          |

**所要の実質は待ち時間で、手を動かすのは 30 分程度。** ステップ 4 の `activate` 以外はすべて元に戻せる。

### 4.4 整合検査をどこに置いたか（#23 (c)）

Secret と `signing_key_metadata` の突き合わせは、次の 4 箇所にある。

| 場所                                    | いつ走るか                      | 失敗したらどうなるか                            |
| --------------------------------------- | ------------------------------- | ----------------------------------------------- |
| `signing-key.mjs verify`                | 運用者が明示的に実行したとき    | 終了コード 1。本番は何も変わらない              |
| `signing-key.mjs activate`              | 署名を切り替える直前（自動）    | 切り替えを中止する                              |
| `JoseSigningKeyProvider`（Worker 本体） | ID Token に署名しようとした瞬間 | **その署名だけが失敗する**。JWKS は応答し続ける |
| `/health` の `checks.signingKey`        | ヘルスチェックのたび            | **何も起きない。** 値が変わるだけ（3.3.1）      |

どれも `domain/services/signing-key-rotation.ts` の **同じ関数**（`parseSigningKeySecret` → `auditSigningKeySecret`）を通る。検査を別コードで書くと「スクリプトは OK と言ったのに Worker は署名できない」が起こりうるので、ここは分けない。`/health` が「配られているか」まで見るのも同じ理由で、JWKS を組み立てる絞り込み（`collectPublicJwks`）を共有している —— 行の有無だけを見ると、`public_jwk` が壊れた行が JWKS から黙って飛ばされるのを見逃す。

#### なぜ 4 つ目を足したのか

3 つで足りていなかったのは、**「誰も `verify` を実行しなければ不一致に気付かない」**という点である。`activate` が自動で検査を挟んではいるが（不一致のまま切り替えるのが最も被害の大きい単一の操作のため）、**鍵を触っていないのに壊れる経路**——Time Travel による巻き戻し（12.4 (2)）、Secret の誤更新、`public_jwk` 行の手修正——はそこを通らない。

#### ステータスには絶対に効かせない

`/health` を避けていた当初の論拠は 3 つあった。**うち 2 つは「HTTP ステータスを動かす場合にだけ」当てはまる。**

- 鍵を一度も設定していない環境（Phase 1 相当の構成、プレビュー環境）で `/health` が赤くなる。死活監視としては正しくない —— Worker は生きていて、OIDC 以外は全部動く。
- **鍵を入れ替えている最中に `/health` が落ちうる。** 監視が鳴るのが一番困る瞬間に鳴る。

だから `checks.signingKey` は**ボディのフィールドとしてだけ**出し、200 / 503 は `checks.database` だけで決める。この分離が崩れた瞬間に上の 2 つがそのまま復活するので、`health.routes.ts` にも同じ注意を書いてある（回帰は `test/health.test.ts` の「署名鍵が未設定でも 200 のまま unavailable を返す」が見ている）。

3 つ目の論拠——`/health` は未認証で叩ける D1 クエリ経路である（8.5 の未決事項 7）——は**いまも当てはまる。** 引き受けた上で、代償を次の 2 点に抑えている。

- **kid は返さない。** 外から鍵の識別子が見えて得られるものが無い。外部が観測できるのは「鍵が揃っているか」の 3 値だけで、これは `/oauth/token` を 1 回叩けば同じことが分かる。
- **D1 のクエリは 1 回しか増やさない。** `listPublishable()` の結果を突き合わせと JWKS 判定の両方に使う（`checkHealth()`）。署名時の経路（Secret の kid ごとに `findByKid()`）をそのまま流用すると、未認証のリクエスト 1 本あたりのクエリ数が鍵の本数だけ増える。

`/health` を認証必須にするか閉じるかを決めるときは（8.5 の未決事項 7）、この項目も一緒に見ること。

#### Worker 本体の挙動は変えていない

`UnconfiguredEmailSender` / `UnconfiguredIpHasher` と同じ方針は維持する —— **失敗は「使おうとした時点」に置く。** 署名鍵の整合が崩れていれば ID Token の発行だけが失敗し、JWKS・Discovery・セッション・アカウント API は動き続ける。鍵を入れ替えている最中に JWKS が落ちると、旧鍵で署名済みのトークンを検証している RP まで巻き込むため、この分離には積極的な意味がある。`checkHealth()` は**観測するだけ**で、何も止めない。

#### デプロイ後のスモークテスト

`.github/workflows/deploy.yml` の auth-worker のスモークテストが `checks.signingKey` が `ok` であることまで確かめる（`scripts/smoke-probe.sh`）。**鍵が未設定のまま本番 URL を設定すると、ここでデプロイが赤くなる。** 12.6 のチェックリストを先に済ませること。

#### CI の投入前検査に足すなら

#### CI に足すなら（`.github/**` は本 PR の対象外）

`.github/workflows/*.yml` のデプロイジョブに、`wrangler deploy` の**前**に次を足す。

```yaml
- name: 署名鍵の整合を確認する
  run: node scripts/signing-key.mjs verify --remote
  working-directory: apps/auth-worker
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    SIGNING_KEY_JWK: ${{ secrets.SIGNING_KEY_JWK }}
```

必要なもの:

1. **GitHub Secrets に `SIGNING_KEY_JWK` を置くこと。** 本番の Secret は `wrangler secret` では読み出せないため、CI が突き合わせるには値の複製が要る。**これは秘密鍵の保管場所を 1 つ増やす判断であり、ローテーションのたびに 2 箇所を更新する運用が生まれる。** 自動検査の価値と引き換えにするかは、鍵の保管経路を増やさない方針（§5.1 の事後対応 3）と照らして決めること。本 PR では判断を保留し、手動の `verify` に留めている。
2. D1 を読む権限を持つ `CLOUDFLARE_API_TOKEN`。
3. `--remote` が本番 D1 を読むため、プレビュー環境では実行しないこと。

複製を増やしたくない場合の代案は、**デプロイ後に `/.well-known/jwks.json` を取得し、`/oauth/token` で実際に ID Token を 1 本発行して `kid` が JWKS に含まれることを確認する**スモークテストである。秘密鍵を CI へ持ち込まずに、同じ不整合（kid の不一致・公開鍵の不一致）を外側から検出できる。ただし検出できるのは「既に壊れた後」で、`verify` のように投入前には止められない。

### 4.5 ローカルで手順を通す

**本番で初めて実行する手順にしない。** 4.2 はローカル D1 と `wrangler dev` でそのまま踏める。下記は #23 で実際に通した順序で、所要は数分（待ち時間を省くため `--active-in` を縮めている）。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services
pnpm db:migrate:local
cd apps/auth-worker
cp .dev.vars.example .dev.vars

# 1 本目の鍵を作り、公開鍵をローカル D1 へ入れる
node scripts/signing-key.mjs generate --kid u18-old-1 --apply-local
#   出力の SIGNING_KEY_JWK= 行を .dev.vars へ貼る
node scripts/oauth-client.mjs seed-dev
node scripts/signing-key.mjs verify         # OK になること

npx wrangler dev --port 8791                # 8787 は他プロジェクトが使っていることがある
```

別端末で Code Flow を 1 周して ID Token を取り、`kid` が `u18-old-1` であることを確認する。そのうえで:

```bash
# ステップ 1-2: 新しい鍵を作り、1 時間後から有効として先行公開する
node scripts/signing-key.mjs generate --kid u18-new-1 --apply-local --active-in 1h
#   出力の SIGNING_KEY_JWK= 行（旧 + 新の 2 本が入っている）を .dev.vars へ貼る

node scripts/signing-key.mjs list           # old=署名中 / new=先行公開
node scripts/signing-key.mjs verify         # 署名は old のまま、new は「情報」として出る
curl -s http://localhost:8791/.well-known/jwks.json | jq '.keys[].kid'   # 2 本出る

# ステップ 4: 署名を切り替える
node scripts/signing-key.mjs activate --kid u18-new-1

# ステップ 7-8: 旧鍵を撤去する（本番では 10 分待ってから）
node scripts/signing-key.mjs retire --kid u18-old-1            # 既定 7 日後。まだ JWKS に残る
node scripts/signing-key.mjs retire --kid u18-old-1 --in 0 --force   # 即時撤去（§5.1 の形）
```

確認する点は 4 つ。

1. 先行公開の間、JWKS には 2 本出るが署名は旧 kid のまま。
2. `activate` の後、新しい ID Token の `kid` が新鍵になる。
3. **切り替え前に取った ID Token が、まだ JWKS の旧鍵で検証できる。**（猶予期間の意味そのもの）
4. `retires_at` を過ぎると旧鍵が JWKS から消え、同じトークンが `ERR_JWKS_NO_MATCHING_KEY` になる。

**ローカル特有の注意 — `.dev.vars` は `wrangler dev` の再起動が要る。** 本番の `wrangler secret put` は再デプロイなしに反映されるが、`.dev.vars` は**起動時にしか読まれない**（起動ログの `Using secrets defined in .dev.vars` が 1 度しか出ない）。貼り替えただけで `activate` すると、Worker 側は旧 1 本しか持っていないため、`activate` の直後から ID Token の発行が次のエラーで止まる。

```text
id token signing failed Error: signing key is not configured:
  kid "u18-old-1" is not active in signing_key_metadata (active_until has passed)
```

**これはローカルだけの制約で、本番には無い。** ただし「Secret を入れたつもりで入っていない状態で `activate` した」ときに本番で起きる症状とまったく同じなので、この表示を一度見ておく価値はある。`verify` は**ファイルの中身**を読むため、この状態でも OK と言ってしまう —— `verify` が答えるのは「この値を入れたらどうなるか」であって「いま Worker が何を持っているか」ではない。

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

2. **新しい kid を即座に現役として登録する。** 4.2 ステップ 2 の「24 時間の先行公開」は**省略する**（`--active-in 0`）。

   ```bash
   cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
   node scripts/signing-key.mjs register --kid <新 kid> --public-jwk '<公開 JWK>' --active-in 0 --remote
   ```

3. **先に Secret を差し替える。** 漏洩した鍵は Set から外し、新しい鍵だけを入れる。

   ```bash
   npx wrangler secret put SIGNING_KEY_JWK   # 新しい鍵 1 本だけの JWK Set
   node scripts/signing-key.mjs activate --kid <新 kid> --remote --secret-file ./new-secret.json
   ```

   **通常時と違い、漏洩した鍵を Set に残さない。** 残す目的はロールバックだが、漏洩した鍵へ戻す選択肢は存在しない。

4. **漏洩した鍵を即座に無効化する。** `active_until` を過去にするだけでは不十分で、`retires_at` も過去にして JWKS から完全に外す。**猶予期間を置かない。** 猶予を置くと、その間ずっと偽造トークンが検証に通る。

   ```bash
   # --force が無いと、下限（24 時間 5 分）を下回る猶予は拒否される
   node scripts/signing-key.mjs retire --kid <漏洩した kid> --in 0 --force --remote
   npx wrangler d1 execute u18-identity --remote --command "
   delete from signing_key_metadata where kid = '<漏洩した kid>';
   "
   ```

   `--force` を要求しているのは、猶予ゼロが**意図した判断であることを明示させる**ため。通常のローテーションで同じ操作を誤って実行すると、正規のトークンを持つ利用者が一斉に検証失敗する。

5. **JWKS から旧 kid が消えたことを確認する。**

   ```bash
   curl -s https://<auth-worker-の-URL>/.well-known/jwks.json | jq '.keys[].kid'
   ```

#### 何が壊れるか（事前に把握しておく）

- **旧鍵で署名された、まだ有効期限内の正規の ID Token が、すべて検証失敗になる。** 最大で 5 分ぶんのユーザーがエラーに遭遇する。これは意図した代償である。偽造トークンを止めることが優先される。Access Token は不透明トークンで署名鍵を使わないため（仕様書 §14.1 決定 5）、この影響を受けない。
- **JWKS を長期キャッシュしている RP は、新しい kid を知らないため一時的にすべての ID Token 検証に失敗する。** RP 側に JWKS キャッシュの破棄を依頼する連絡経路を、事前に用意しておくこと。
- **ブラウザセッションは壊れない。** セッションは `sessions` テーブルの `token_hash` で検証しており、署名鍵を使わない（`apps/auth-worker/src/application/use-cases/get-session.use-case.ts`）。ユーザーは再ログインを求められない。

#### 発行済みトークンの無効化

偽造された Access Token を個別に止める確実な手段は、現時点では存在しない。

- **Access Token は不透明トークン**（#37 / 仕様書 §14.1 決定 5）。`oauth_tokens` に行があるので DB で失効できる。そして**偽造されたトークンは DB に行を持たないため、そもそも検証を通らない**。つまり署名鍵が漏洩しても、その影響は ID Token に限定される。

  > 以前この節には「JWT の場合」の分岐も書かれていたが、決定により不要になったので削除した。JWT を再検討する場合は §8.3 の論点に戻ること。

  ```bash
  npx wrangler d1 execute u18-identity --remote --command "
  update oauth_tokens set revoked_at = unixepoch() * 1000 where revoked_at is null;
  "
  ```

- **ID Token は本質的に失効できない。** ステートレスであり、`exp` までは有効である。だから寿命を 5 分に抑えてある（仕様書 5.3）。鍵を JWKS から外すことが唯一の対抗手段である。

**この論点は #37 で決着した。** 不透明トークンを採ったことで、鍵漏洩時の無効化は DB 操作で完結し、本プレイブックは上記のとおり単純化されている。

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

**レート制限は入っており、Turnstile は採らないと決定した**（仕様書 §14.1 決定 13 / 脅威モデル RR-2。再検討の条件は「レート制限で止まらない濫用が実際に観測されたとき」）。 `/api/auth/email/start` / `/api/auth/email/verify` / `/api/auth/passkeys/login/verify` に IP 単位のバースト制限がかかり、アドレス単位の持続制限が `email_challenges` の行数で効いている（§13）。**`/oauth/token` と `/oauth/authorize` にはまだかかっていない** —— #15 / #16 の実装後に足す。`email_challenges` の `resend_count` 列は使っていない（#88）。

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
- dashboard-worker の `/account/health` も **503**、`checks.identity` が `degraded`（§3.3.2）。auth-worker は生きているが D1 へ届いていない、という切り分けがそのまま出る。

#### 動くもの / 動かないもの

| 機能                                             | D1 障害時           | 理由                                                                                                                                                                                                                             |
| ------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/openid-configuration`          | **動く**            | `oauth.routes.ts` は `c.env.ISSUER` から静的に組み立てており、DB を読まない                                                                                                                                                      |
| `GET /health`                                    | **応答する（503）** | 診断が目的。503 を返すこと自体が正常動作                                                                                                                                                                                         |
| 501 を返す各 endpoint                            | 動く（501 のまま）  | DB に触れていない                                                                                                                                                                                                                |
| `GET /api/me`、`GET /api/me/sessions`            | **動かない**        | セッション検証が `sessions` テーブルを引く                                                                                                                                                                                       |
| `DELETE /api/me/sessions/:id`                    | **動かない**        | 同上                                                                                                                                                                                                                             |
| `IdentityRPC` の全メソッド                       | **動かない**        | すべて `createContainer` 経由で D1 を使う                                                                                                                                                                                        |
| dashboard-worker の `/api/me` 系                 | **動かない**        | RPC が失敗し、`identity_unavailable` → HTTP 503 に翻訳される                                                                                                                                                                     |
| ログイン（Phase 1 残り）、OIDC フロー（Phase 2） | **動かない**        | セッション・認可コード・OTP の正本はすべて D1                                                                                                                                                                                    |
| **既存セッションでの RP 側の継続利用**           | **RP の実装による** | RP が ID Token を検証済みで自前のセッションを持っていれば、u18 に問い合わせない限り動き続ける                                                                                                                                    |
| JWKS（`/.well-known/jwks.json`）                 | **動かない**        | `signing_key_metadata` を読むため（#14 で実装済み）。この経路に秘密鍵を持ち込まない方針を優先し、Secret 側の値だけで応答するフォールバックは入れていない。入れると「テーブルに登録していない鍵が JWKS に出る」状態を作れてしまう |

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

#### 復元は「空の DB」にしか流せない

**`d1 export` の出力を、中身のある D1 へ `d1 execute` で流し込むことはできない。**

```
✘ [ERROR] UNIQUE constraint failed: d1_migrations.id
```

ダンプには `d1_migrations` テーブルの行が含まれており、既に同じマイグレーションを適用済みの DB では主キーが衝突する。**「本番を上書きして戻す」という操作は、この経路では成立しない。**

手順は次の 3 段になる。

1. **新しい D1 を作る**（`wrangler d1 create u18-identity-restore` など）
2. そこへダンプを流し込む
3. `wrangler.jsonc` の `database_id` を新しい DB の ID へ差し替えてデプロイする

**3 を行うと、上の「ローカル D1 が別実体になる」が全員の手元で再発する。** 復旧作業の連絡には、手元を作り直す必要がある旨も含めること。

Time Travel（§6.2）は同じ DB の中で時刻を戻すので、この制約を受けない。**まず Time Travel を試し、それで足りないときだけエクスポートからの復元を使う**という順序になる。

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

### 7.0 保持期限と自動削除（#43）

#### 決定した保持期間

##### `nfc_card_events`（別 D1）

**この表は `u18-identity` の 5 テーブルだけである。** `u18-nfc` の `nfc_card_events` は別の D1 なので対象外で、**掃除する経路が 1 つも無かった**（仕様書 §9 Privacy は保持期間の明示を要求しているので、決めていないこと自体が要求を満たしていなかった）。

| イベント                                | 保持       | 理由                                                                                                                          |
| --------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `card.claimed` / `card.released`        | **2 年**   | **カードの支配権が移った記録。** 「誰がこのカードを取ったか」は争いになってから訊かれる —— 文化祭で配った当日ではなく、後から |
| `card.target_updated` / `card.disabled` | **180 日** | 現在の遷移先は `nfc_cards.target_url`、停止中であることは `nfc_cards.status` に残る。消えるのは「いつ変えたか」だけ           |

正本は `apps/nfc-worker/src/domain/services/retention-policy.ts`。Identity 側と**意図的に基準を揃えてある**（「支配権が変わる操作」を長期側に置く）が、定数は共有していない —— 共有すると nfc-worker の依存グラフから Identity 側のテーブル定義が見える。

**掃除は nfc-worker 自身の Cron（毎時 17 分）が回す。** auth-worker からは回せない —— `u18-nfc` の binding を持たないため（持たせると「nfc-worker が侵害されても Identity は読めない」という §1.3 の線が逆向きに崩れる）。**このリポジトリには Cron が 2 本ある。**

```bash
npx wrangler tail u18-nfc-production --format json --search "nfc.retention.sweep"
# {"event":"nfc.retention.sweep","deleted":0,"limit":1000,"failed":null,"deadlines":{...}}
```

0 件でも出る。「最後にいつ掃除が走ったか」を件数ではなくログの有無で判断するため。

起点は **行が使えなくなった時刻**（期限切れ / 失効 / 消費、`email_challenges` は最終送信も含む）であって、作成時刻ではない。定義は `apps/auth-worker/src/domain/services/retention-policy.ts` の `RetentionPolicy` に集約してある。**値を変えるときはこの表とコードの両方を直すこと。**

| テーブル                    | 保持期間    | 消す行                               | 根拠                                                                                                    |
| --------------------------- | ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `sessions`                  | **30 日**   | 期限切れ・失効済み                   | セッション一覧 UI の履歴表示と侵害調査。D1 Time Travel の 30 日窓とも揃う                               |
| `oauth_authorization_codes` | **24 時間** | 消費済み・期限切れ                   | コードの寿命は 60 秒だが、消費済み行は「同じコードが 2 回来た」の事後照合に使える                       |
| `email_challenges`          | **1 時間**  | 消費済み・期限切れ（最終送信も見る） | **5 つの中で最短。** このテーブルだけメールアドレスを平文で持つ（仕様書 9 Privacy）。下の注意も読むこと |
| `webauthn_challenges`       | **24 時間** | 消費済み・期限切れ                   | 単回消費で個人情報を含まない。当日中の調査に足りる長さだけ残す                                          |
| `audit_logs`                | **180 日**  | 記録から 180 日経過                  | §7.2 の推奨値。インシデントの発覚は遅れるため直近半年を遡れる必要がある                                 |

**`users` は対象外である。** アカウントは物理削除せず凍結で表現する（仕様書 14.1 決定 7）。凍結アカウントの保持期間は未決で、#27 / #51 で扱う。§7.1 の物理削除は引き続き運用者の手動操作である。

**`oauth_tokens` はまだ対象に入っていない。** トークンを発行する経路（#15 / #16）の実装と合わせて追加すること。`RetentionPolicy` にエントリを足し、`DrizzleExpiredRecordPurger` に `case` を 1 つ書けば同じ Cron に乗る。

#### `email_challenges` を 1 時間より短くしてはならない理由

**再送上限が `email_challenges` の行を数えて成り立っているため、保持期間を短くすると上限が緩む。**

`StartEmailOtpUseCase` は「直近 `OtpPolicy.resendWindowMs`（1 時間）の間にそのアドレス・用途で作られた行数」で再送上限を判定する（#88）。掃除で消えた行は数えられないので、**保持期間が窓より短いと、待つだけで上限を回り込める**。現在はどちらも 1 時間で余裕がゼロである。短くするなら `OtpPolicy.resendWindowMs` を先に短くすること。

`last_sent_at` はクールダウン判定（`OtpPolicy.resendCooldownMs` = 60 秒）にも使われている。消費済みの行を即座に消すと、「コードを受け取って消費する → 行が消える → 送信履歴が無くなる」という順序でクールダウンを回り込める。そのため削除条件には `expires_at` と `consumed_at` に加えて **`last_sent_at` も入っている**。

回帰テストは `apps/auth-worker/test/retention.test.ts` の「クールダウン窓の内側にある消費済みの行は消さない」と、`apps/auth-worker/test/otp-resend-limit.test.ts` の「窓は保持期間を超えてはならない」。後者はどちらの定数を動かしても落ちる。

なお `email_challenges.resend_count` 列は**使われていない**。かつてこの列で再送回数を数える設計だったが、送信のたびに新しい行を作るためカウンタが常に 0 に戻り、上限が一度も発動しなかった（#88）。列は残っているが読んでも書いてもいない。

#### 実行経路

**掃除の経路は 1 本だけである。** Cron Trigger → `apps/auth-worker/src/index.ts` の `scheduled` → `PurgeExpiredRecordsUseCase` → `ExpiredRecordPurger`（Port）→ `DrizzleExpiredRecordPurger`。

```text
*/15 * * * *  →  scheduled()  →  PurgeExpiredRecordsUseCase.execute()
                                    └─ 5 テーブルを直列に、テーブルごとの保持期間で
```

テーブルごとに Cron やハンドラを分けていないのは意図的である。経路が分かれると、片方だけ止まっていても誰も気づかない。

Cron 式は `apps/auth-worker/wrangler.jsonc` の `triggers.crons` に書く。**`env.production` にも同じものが要る**（env ごとの設定は継承されない）。ここを書き忘れると、本番だけ掃除が走らないまま D1 が増え続け、容量上限に達した時点で監査ログが静かに欠落し始める。

#### 1 回あたりの上限と持ち越し

1 回の実行で 1 テーブルから消すのは **1,000 行まで**（`RETENTION_SWEEP_LIMIT`）。D1 は 1 ステートメントの実行時間に上限があり、溜まった行を 1 回の `delete` で消そうとすると途中で落ちる。落ちた分は 1 行も消えないので、「溜まっているほど掃除が失敗する」という最悪の挙動になる。

上限に達した分は次回の実行へ持ち越す。15 分間隔なので 1 テーブルあたり 1 日 96,000 行を処理できる。

#### 動いていることをどう確認するか

実行のたびに、件数が 2 か所に残る。**0 件でも必ず出る**ので、「最後にいつ掃除が走ったか」はログの有無で判断できる。

1. Workers の構造化ログ（`observability` が有効なのでダッシュボードから検索できる）

   ```text
   retention sweep  { deleted, byTarget, carriedOver, failed, limit }
   ```

2. `audit_logs` の `event = 'retention.sweep'`

   ```bash
   cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
   npx wrangler d1 execute u18-identity --remote --command "
   select datetime(created_at/1000, 'unixepoch') as at, outcome, metadata
   from audit_logs where event = 'retention.sweep' order by created_at desc limit 10;
   "
   ```

監視で拾うべき異常は 3 つ。

- **`retention.sweep` が 1 時間以上出ていない** — Cron が止まっている。`triggers.crons` が本番 env に無いことを最初に疑う
- **`carriedOver` が毎回出続ける** — 流入が掃除の速度を超えている。1 回の上限を上げるのではなく、先に Cron の間隔を詰める（D1 の実行時間上限から遠いままでいられる）
- **`failed` が空でない** — そのテーブルの削除が落ちている。`retention sweep failed` のログに原因が出る

#### 手動で 1 回走らせる

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
# ローカル。wrangler dev 起動中に別端末から叩く
npx wrangler dev
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

本番で即時に走らせる手段は無い。緊急に大量削除が必要なときは §7.2 の SQL を手で実行する。

### 7.1 アカウント削除

#### スキーマ上の前提

`users` には論理削除のための 2 つの要素がある。

- `status`（`active` / `suspended` / `deleted`）
- `deleted_at`（`timestamp_ms`、NULL 可）

> **訂正（#27）。** 以前ここには「**認証の遮断に効くのは `status` だけである**。`User.isActive` は `status === "active"` しか見ておらず `deleted_at` を参照しないので、`deleted_at` だけを設定したユーザーは引き続きログインできる」と書かれていた。**これは既に正しくない。** 現在の `User.isActive`（`apps/auth-worker/src/domain/entities/user.ts`）は `status === "active" && deletedAt === null` であり、**どちらか一方を立てれば認証は止まる。**
>
> 削除処理で両方を設定するという結論は変わらない。`deleted_at` は保持期間の起点として要り、`status` は状態の意味（削除依頼か BAN か）を表すためである（§11.1）。

即時に物理削除しない理由は、監査ログとの整合、誤削除からの復旧、法的な照会への対応である（`packages/db/src/schema/users.ts` のコメント / 仕様書 7.3）。

#### 削除手順

> **本節は物理削除を前提にした流れで書かれており、仕様書 §14.1 決定 7（物理削除しない）より前の記述が残っている。** 利用者から「削除してほしい」と言われたときに実行するのは **§11「アカウント削除（＝凍結）」**である。本節の手順 8（物理削除）は、法的な照会などで完全消去が必要になった例外的な場合の参考として残してある。

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

**この一連の処理を自動化するバッチは存在しない。** §7.0 の Cron は `users` を意図的に対象外にしている。アカウントは物理削除せず凍結で表現する決定（仕様書 14.1 決定 7）があり、凍結アカウントの保持期間自体がまだ決まっていないためである。期間が決まるまで自動削除の経路を先に作ると、方針より先に実装が既成事実になる。#27 / #51 で扱う。

### 7.2 `audit_logs` の保持

#### 180 日を過ぎた行は消える前に R2 へ退避される（#43 の残件）

削除の直前に NDJSON で `u18-identity-archive` バケットへ書き、**書けたことを確認してから**消す（`apps/auth-worker/src/infrastructure/archive/r2-archive-sink.ts`）。キーは `audit_logs/YYYY/MM/DD/<timestamp>-<rand>.ndjson`。

**退避に失敗したら削除しない。** 退避が静かに失敗したまま削除を続けると、壊れていると分かるのは「半年前の行を見に行ったら無かった」時、つまり侵害調査の最中になる。失敗したときは `audit_logs` の掃除だけが止まり、行が溜まる（§12.7）。

**この経路は本番で 1 往復確認済み**（2026-10-24、§12.7）。実データの退避が始まるのは最初の行が 180 日を過ぎてからなので、それまでバケットにはプローブのオブジェクトが 1 件あるだけである。

どのキーに入ったかは構造化ログに出る。消えた行を探すときの入口になる:

```bash
npx wrangler tail u18-auth-production --format pretty | grep "retention archive"
# {"target":"audit_logs","key":"audit_logs/2026/04/27/…","rowCount":1000,…}
```

**他の 4 テーブルは退避しない。** 消してよいから消しているのではなく、消さなければならないから消しているため（`domain/services/retention-policy.ts` の `ARCHIVED_TARGETS`）。とくに `email_challenges` は 5 つの中で唯一メールアドレスを平文で持ち、保持期間を最短の 1 時間にしてある。R2 へ写すとその判断が無意味になる。

#### 現状

- 保持期間は **既定 180 日、一部のイベントは 2 年**（§7.0、#43 / #22）。15 分おきの Cron が自動で削除する。区分は下記。
- 削除の前に R2 へ退避される（上記）。**退避に失敗したら削除しない。**
- `audit_logs` にはインデックスが 3 本（`event+created_at`、`user_id+created_at`、`created_at`）あり、行数に比例してストレージを消費する。D1 のデータベースサイズには上限があるため、放置すれば最終的に書き込みが止まる。
- 書き込み失敗は握り潰される（`drizzle-audit-logger.ts`）。つまり **DB が容量上限に達しても、認証は動き続け、監査ログだけが静かに欠落する。** ログに `audit log write failed` が出るので、これを監視対象に入れること。

#### イベント区分ごとの保持（#22、適用済み）

正本は `apps/auth-worker/src/application/ports/audit-log.port.ts` の **`AUDIT_EVENT_RETENTION`**。期間そのものは `domain/services/retention-policy.ts` の `AuditRetention` が持つ。

| 区分       | 保持       | 入るイベント                                                                                                                                     |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `security` | **2 年**   | `passkey.register` / `passkey.deleted` / `profile.updated` / `oauth.grant.revoked` / `session.revoke` / `session.logout` / `oauth.code.replayed` |
| `standard` | **180 日** | 上記以外のすべて                                                                                                                                 |

**長期側に置く基準は「アカウントの支配権が変わる操作」。** 「攻撃者がいつ自分の認証器を足したのか」は半年以上経ってから訊かれる質問で、一律 180 日だと**侵害が発覚するより先に記録が消える**。これらは量が少ないので、2 年持っても行数に効かない。

逆に `oauth.userinfo` や `oauth.token.issued` のような**リクエストごとに 1 行出るイベント**は `standard` に置く。行数を押し上げている本体であり、古くなるほど価値が下がる（2 年前の UserInfo 取得を遡る理由が無い）。

##### 知っておくべき制約 2 つ

1. **選別は `event` 名でしかできない。** `reason` で絞ると WHERE 句が `(event, created_at)` のインデックスから外れ、掃除自体が重くなる。結果として「失敗だけ長く残したい」イベントは**成功も一緒に残すコスト**と引き換えになる。
   **実際にそうした例が `passkey.counter_regression` である**（#147）。認証器の複製の兆候は 2 年残したいが、`passkey.login` の `reason` に畳んだままでは 180 日で消える。かといって `passkey.login` を長期側へ移すと、成功したログインすべてが 2 年残って量に見合わない。**区分ではなく名前の問題なので、名前を分けた。**

   `passkey.counter_regression` が出たとき `passkey.login` は**出ない**。両方に出ると調査で件数が二重に見える。

   > **過去のデータとは食い違う。** 名前を分ける前（2026-10-25 より前）に記録された巻き戻しは `passkey.login` の `reason: counter_regression` のままなので、それ以前を遡るときは両方を見ること。追加であって改名ではないので、既存の行は壊れていない。

2. **`rate_limit.exceeded` は `audit_logs` に入らない**（#21）。Workers のログへ出している。区分表には型の都合で載っているが、掃除の対象にこの名前の行は現れない。

##### 区分を変えるとき

`AUDIT_EVENT_RETENTION` は `Record<AuditEventName, AuditRetentionTier>` なので、**イベントを足すとコンパイルエラーになる。** 区分を決めないと通らない。既定へ黙って落ちる形にしていないのは、新しい高リスクイベントが 180 日で消える状態が無言で生まれるのを防ぐため。

回帰は `apps/auth-worker/test/retention.test.ts`（同じ日付の 2 行が区分で生死を分けること）と `test/audit-events.test.ts`（登録簿との過不足、`security` が `standard` より長いこと）が見ている。

#### 手で削除する手順（Cron が止まっている / 緊急で容量を空ける場合）

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
-- ⚠️ 区分を無視して消す。2 年残すはずのイベント（AUDIT_EVENT_RETENTION の
--    security）まで落ちるので、容量が逼迫しているとき以外は使わないこと。
--    区分を尊重するなら Cron を待つか、event not in (...) を足す。
delete from audit_logs where created_at < (unixepoch() - 180 * 86400) * 1000;
"
```

一度に大量の行を削除すると D1 のクエリ時間上限に当たる。初回は期間を区切って小分けに実行する。

#### 期限切れ行の滞留を確認する（audit_logs 以外）

掃除は自動で走る（§7.0）。それでも溜まっているなら Cron が止まっているか、流入が掃除の速度を超えている。件数はこれで見る。

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

`sessions` は 12 時間で期限切れになるため、最も速く増える。保持期間は §7.0 の表で確定済み（期限切れ後 30 日）。**`oauth_tokens` だけがまだ自動削除の対象に入っていない**（#15 / #16 の実装と合わせて追加する）ので、当面はこの SQL で件数を見て、必要なら手で消すこと。

```bash
npx wrangler d1 execute u18-identity --remote --command "
delete from oauth_tokens where expires_at < (unixepoch() - 86400) * 1000;
"
```

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

## 8. 決定事項と、残っている運用課題

仕様書 §14 の項目を運用の言葉で言い換える。

> **改訂**: 本節は元々「未決事項と、それが止めている運用判断」だった。その後 §14 の多くが決着したため（#33 / #35 / #37 / #40）、各項目を**決定の内容と、決定後も残っている運用課題**に書き換えた。決着したものを「未決」と書いたままにすると、読んだ人が既に決まったことを決め直すか、本書全体の鮮度を疑うことになる。
>
> **本番公開を止めている最大の要因は、もはやドメイン未決ではない。** D1 の払い出し（#5）とレート制限の不在（#21）である。

### 8.1 本番 Issuer ドメインと Cookie の境界（仕様書 14-1）— **決着済み**

**決定**（#33 / PR #77 / 仕様書 §14.1 決定 1）:

| 項目                      | 値                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `ISSUER`                  | `https://auth.under18.dev`                                                            |
| auth-worker の route      | `auth.under18.dev/*`                                                                  |
| dashboard-worker の route | `auth.under18.dev/account/*`（登録パスも `/account` 接頭辞付き。`ACCOUNT_BASE_PATH`） |
| WebAuthn `RP_ID`          | `under18.dev`（ゾーン）                                                               |
| `WEBAUTHN_ORIGIN`         | `https://auth.under18.dev`（ホスト）                                                  |

3 択のうち **(1) 同一ホスト・パス分離**を採った。`__Host-` の保護を捨てずに dashboard がセッションを読める。Cloudflare は route をより長い pattern 優先で解決するため両立する。

**運用上、引き続き注意すること**:

1. **`ISSUER` は一度公開したら変えられないものとして扱う。** Discovery の `issuer` は RP 側に設定される値で、後から変えると全 RP の再設定が必要になる。
2. **`RP_ID` はさらに変えられない。** WebAuthn の Credential は `RP_ID` に紐づくため、変更すると登録済みの全 Passkey が使えなくなる。ホストではなくゾーンを選んだのは、IdP のホスト名を動かす余地を残すためである。
3. **`RP_ID` が広いことを根拠に Cookie のスコープを広げないこと。** RP ID はゾーン、Cookie は発行ホストのみ —— このズレは意図的である。広げた RP ID を無効化しているのは `WEBAUTHN_ORIGIN` との**厳密一致**だけなので、origin 検証を緩めるとこの決定がそのまま穴になる。
4. **Origin 検証は文字列一致ではない。** `apps/auth-worker/src/presentation/http/origin.ts` は `new URL(...).origin` に正規化してから比較する（#46 で修正済み）。末尾スラッシュや大文字小文字の揺れでは落ちない。ただし **`Origin` ヘッダが無いリクエストは拒否する**（fail-closed）ので、運用で `curl` から状態変更系を叩くときは `-H "Origin: https://auth.under18.dev"` を付ける。
5. **auth と dashboard で Origin 検証の基準が異なる。** auth は `ISSUER` を基準に、dashboard は自分のリクエスト URL の Origin を基準にする。同一ホスト構成では一致するが、構成を変えるときはここを見直すこと。

### 8.2 メール送信プロバイダ（仕様書 14-3）— **決着済み**

**決定**（#35 / 仕様書 §14.1 決定 3）: **Cloudflare Email Sending**（`wrangler.jsonc` の `send_email` バインディング）。実装は `infrastructure/email/cloudflare-email-sender.ts`。**API キーの Secret を持たない。**

以前ここには「本番で auth-worker が起動できない」と書かれていたが、それは #53 でも解消されている（設定不備は起動時ではなく送信時に失敗する）。

#### 送信できる条件（実際に踏んだので記録する）

任意の宛先へ送るには **2 つ**の前提がある。どちらも欠けると送信時に失敗する（起動時には分からない）。

| 前提                                                                      | 欠けたときの症状                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **送信ドメインの onboarding**（ダッシュボード → Email Service → Sending） | `E_RECIPIENT_NOT_ALLOWED`。onboarding 前は「検証済み宛先」にしか送れない |
| **Workers Paid プラン**                                                   | Free では outbound sending が "Not available"                            |

料金は **月 3,000 通まで込み、超過は $0.35 / 1,000 通**。検証済み宛先への送信はどのプランでも無料で、この quota にも乗らない。

> **金額は公式の Pricing ページで確認してから使うこと。** 公式の [Limits](https://developers.cloudflare.com/email-service/platform/limits/) ページには料金も込み通数も書かれておらず、「検証済み宛先への送信は常に無料で、どのプランでも quota と日次上限に乗らない」とだけある。上の数字は別経路で得たもので、**予算の根拠にするには一次情報で裏を取る必要がある**。製品は public beta なので変わりうる。
>
> 同ページは plan ではなく **「送信ドメインを onboarding したかどうか」** で区切って説明している（onboarding 前は検証済み宛先のみ、onboarding 後は任意の宛先へ即座に送れる）。上の表の 2 行は実地で踏んだ事実として正しいが、**公式ドキュメント上の切り分けとは軸が違う**ので、参照するときは両方を見ること。

> **`E_RECIPIENT_NOT_ALLOWED` は誤解を招くコードである。** 公式ドキュメントはこれを「宛先が `allowed_destination_addresses` に無い」と説明しているが、**本リポジトリはそのキーを設定していない**。つまり文書どおりならこのコードは出ないはずで、**存在しない allowlist を探すことになる**。
>
> 未 onboarding 専用の `E_SENDER_DOMAIN_NOT_AVAILABLE` が別に定義されているのに使い分けられていないのが原因。**このコードを見たら、まず Email Sending の有効化とドメイン onboarding を疑うこと。**
>
> 実際に本番で踏んだ。Worker ログに `otp email send failed { code: E_RECIPIENT_NOT_ALLOWED }` が出ていたが、原因は allowlist ではなく製品が未有効化だったこと。有効化後は同じ設定のまま送信が通った。

**検証済み宛先なら Free でも動く**ため、**手元の検証が通っても本番で落ちる**形になりうる。本番公開前にプランを確認すること。

#### 送信失敗は `/health` に出ない

設計上の判断として、`/health` はメール送信を見ない（#53 の「設定不備が無関係なエンドポイントを巻き込まない」方針）。したがって**送信基盤が全面的に壊れていても外形監視は緑のまま**になる。

さらに現状、**送信が失敗しても監査ログは `otp.start` を `success` と記録する**（#141）。実際に本番で 2 回失敗したが、どちらも監査ログ上は成功しており、`wrangler tail` を張って初めて分かった。

→ **「OTP が届かない」という問い合わせが来たら、まず `wrangler tail --env production` でログを見ること。** 監査ログと `/health` のどちらも当てにならない。

**残っている運用課題**:

1. **到達性の監視手順が未整備。** バウンス率・遅延・ブロックをどこで見るか、「OTP が届かない」という問い合わせへの調査手順が本書にまだ無い。Cloudflare 側のダッシュボードで何が見えるかを確認して書く必要がある。
2. **OTP 障害時のエスカレーション先が未定。** メールが止まると、Passkey を持たないユーザーは完全にログインできなくなる（#34 により Passkey は任意なので、そういうユーザーは必ず存在する）。障害告知のみで済ませるのか代替手段を用意するのかを決める。
3. **`EMAIL_FROM` のドメイン検証が前提。** 本番は `noreply@under18.dev`。このドメインが Cloudflare 側で検証済みでないと送信が実行時に失敗する。**デプロイ前に確認すること。**

### 8.3 Access Token の形式（仕様書 14-5）— **決着済み**

**決定**: **不透明トークン + DB 失効**（#37 / 仕様書 §14.1 決定 5）。`oauth_tokens` にハッシュを保存し、`/oauth/userinfo` と `/oauth/revoke` はサーバー側で状態を見る。

この節は「止めている運用判断」を列挙していたが、すべて決着した。結果として確定したこと:

1. **署名鍵漏洩時のプレイブックは 1 通りになった**（§5.1）。DB の UPDATE で確実に止められる。偽造トークンは DB に行が無いので検証を通らず、鍵漏洩の影響は ID Token に限定される。
2. **鍵ローテーションの待ち時間は ID Token の 5 分**（§4.2 ステップ 5）。JWT 前提の保守的な 15 分は不要になった。
3. **`/oauth/revoke` は「revoke した」と言い切れる。** DB の状態が正本なので、`exp` まで RP 側で通ってしまう問題が無い。
4. **引き換えに D1 の負荷は増える。** Access Token の検証ごとに `oauth_tokens` を引くため、D1 障害時の縮退範囲（§5.4）が広がる。**これは受け入れたコストであり、監視対象である。**

### 8.4 MFA / 管理者アカウント復旧のポリシー（仕様書 14-8）— **決着済み**

**決定**（#40 / 仕様書 §14.1 決定 8）: **管理者は Passkey 必須。メール OTP 単独ではログインも復旧もできない。** 一般利用者向けの MFA（TOTP 等）は導入しない —— Passkey は `userVerification: "required"` を強制しており単体で所持＋生体/PIN の 2 要素を満たすため。

**強制する仕組みは #83 で入った。** `users.is_admin` が追加され、管理者のセッションは `authMethod: "passkey"` でしか発行されず、管理者は最後の Passkey を削除できない。付与は Passkey が 1 本以上あるアカウントにしか通らない。手順は §10.5 を参照。

**残っている運用課題**:

1. **本番 Secret へのアクセス権と、アプリ上の管理権限の関係が未定義。** 本書 §5 の手順はすべて `wrangler` での DB 直接操作を前提にしており、実行には Cloudflare アカウントへのアクセスが要る。**#83 が入った後も、管理者だけが叩けるアプリ上の機能は 1 つも無い** —— `users.is_admin` が決めるのは「決定 8 を適用するか」だけで、実権は依然としてインフラ管理者にある。アプリ側に管理機能を作るかどうかは未定のままで、作るときは「OTP で入った管理者は存在しない」という #83 の前提の上に乗せること。
2. **「誰が誰を復旧してよいか」が未定。** 2 名承認を要求するのか、本人確認の方法は何か、記録はどこに残すのか。決まらないと復旧依頼への応対がその場の判断になる。全 Passkey を失った管理者の復旧は**自動化しない**ことだけが決まっている（仕様書 6.1 の「追加の再認証・審査」）。
3. ~~**#75 との相互作用。**~~ **解決済み（#83）。** 管理者は最後の 1 本を削除できない（`DeletePasskeyUseCase` が `conflict` を返す）。一般利用者は従来どおり 0 本まで削除できる（#34 により OTP が常に残るため）。**この非対称は意図したものなので、「一般利用者にも最後の 1 本を残させる」方向へ揃えないこと** —— 盗まれた端末の認証器を外せなくなる（#75）。

### 8.5 その他、本書の執筆中に判明した未決事項

仕様書 14 に挙がっていないが、運用上決める必要があるもの。

1. **バックアップの実行頻度と自動化手段**（§6.3）。現在エクスポートは完全に手動であり、スケジュール実行の仕組みが存在しない。
2. ~~**`audit_logs` およびセッション行の保持期間**~~ — 決定済み（§7.0、#43）。残るのは「高リスクイベントだけ 2 年残す」区分の実装と、削除前のアーカイブ、`oauth_tokens` の対象追加。
3. **`ip_hash` の保持期間**（§7.3）。
4. **削除済みメールアドレスの再利用可否**（§7.1 手順 7）。`lower()` 式の UNIQUE インデックスにより、現状では再登録できない。
5. **`IP_HASH_PEPPER` のローテーション方式**（§2.4.2 / §7.3）。未設定の検知は `container.ts` のハードフェイルで解決済みだが、pepper を世代管理する仕組みがないため、変更すると過去の `ip_hash` がすべて照合不能になる。
6. ~~**`signing_key_metadata` と `SIGNING_KEY_JWK` の整合を検証する手段**~~ — 対処済み。`/health` の `checks.signingKey` が、現役の kid が Secret にあり JWKS にも出ているかを返す（§3.3.1 / §4.4）。デプロイ後のスモークテストもこの値を見る。**残るのは「投入前に止める」経路**で、そちらは CI へ `SIGNING_KEY_JWK` を複製する判断が要る（§4.4）。なお、かつてここに書いてあった「現役 kid と `SIGNING_KEY_KID` の一致を見る」案は採れない —— `SIGNING_KEY_KID` は #23 で単一 JWK 形式の後方互換にしか使われなくなっており、JWK Set 形式では**どの鍵で署名するかを決めるのは `signing_key_metadata` の `active_from` / `active_until`** である。
7. ~~**`/health` を公開したままにするか**~~ — 決着（脅威モデル RR-18）。**公開は維持し、返す内容を削った。** 認証を要求すると「デプロイ直後に外から確認できる」という価値を失い、スモークテスト（§4.4）も作り直しになる。代わりに `environment` と `issuer` を外した —— `issuer` は Discovery が公開を必須にしているので重複、`environment` は外に見せる理由が無い。`--env production` の付け忘れの検知は Discovery の `issuer` へ移してある。
8. ~~**`compatibility_date` を仕様書の 2026-10-24 へ揃える時期**~~ — 解決済み（#108）。`@cloudflare/vitest-plugin` への移行でテストと deploy の workerd が 1 本に揃い、据え置く理由が消えた。3 つの Worker とも `2026-10-24`。

---

## 9. OAuth クライアントの登録と失効（#13）

MVP に公開 Developer Portal は無い（仕様書 1.2）。クライアントの登録・失効は、運用者の手元から `apps/auth-worker/scripts/oauth-client.mjs` を実行して行う。登録用の HTTP エンドポイントは**作らない**。作ると「任意の `redirect_uri` を持つクライアントを誰でも登録できる」状態になり、認可コードの宛先を攻撃者が自分で用意できてしまう。Redirect URI の完全一致検証（§9.2）が前提から崩れる。

### 9.1 登録

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services
pnpm --filter @u18/auth-worker client:create -- \
  --client-id u18-dashboard \
  --name "u18 Dashboard" \
  --type confidential \
  --first-party \
  --redirect-uri https://auth.under18.dev/account/callback \
  --remote
```

| オプション            | 意味                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| `--type confidential` | `client_secret` を持つ。生成した秘密は**実行時に 1 度だけ表示される**  |
| `--type public`       | 秘密を持たず PKCE だけで認証する（仕様書 5.1）                         |
| `--first-party`       | u18 公式サービス。同意画面を省略してよい                               |
| `--redirect-uri`      | 複数回指定できる。完全一致で検証されるので、クエリまで含めて実物を書く |
| `--scopes`            | 既定は `openid profile email`                                          |
| `--remote`            | 本番 D1 に対して実行する。付けないとローカル D1（miniflare）に入る     |
| `--dry-run`           | SQL を表示するだけで実行しない。レビューや記録に残したいときに使う     |

**`client_secret` は DB にハッシュしか入らない**（仕様書 7.1）。平文は実行時の出力にしか存在せず、取り損ねたら再発行するしかない。これは不便ではなく、「後から誰でも読み出せる平文」を作らないための形である。出力は端末のスクロールバッファと履歴に残るので、クライアントへ渡したら §2.4.1 と同じ要領で消すこと。

同じ `client_id` の二重登録は `oauth_clients_client_id_unique` が止める。スクリプト側では存在確認をしていない。「確認してから挿す」に分けると、同時に 2 本走ったときに両方が「無い」と判断しうるため。

### 9.2 Redirect URI に関する制約

登録時の検証は `apps/auth-worker/src/domain/services/redirect-uri.ts` が持ち、スクリプトはそれをそのまま読み込んでいる（ルールを 2 箇所に書くと、登録で通った URI が認可時に弾かれる形でずれる）。

- **絶対 URI で `https:` のみ。** 認可コードは `Location` ヘッダと URL バーに載るので、平文 HTTP だと経路上の第三者が読める。
- **フラグメント禁止。** 認可応答の組み立てと衝突する。
- **正規形であること。** 大文字スキーム・既定ポートの明示（`:443`）・パス省略は拒否する。曖昧な入力を黙って正規化すると、登録した文字列とクライアントが送る文字列がずれ、認可時に完全一致で落ちる。原因は URL を目視しても分からない。
- **`http://localhost` は `--allow-loopback-http` を明示したときだけ。** ループバック宛のパケットはマシンの外へ出ないので盗聴の前提が成り立たない（RFC 8252 §7.3 と同じ根拠）。ただし**既定では許さず、`--remote` との併用も禁止している**。本番 IdP に `http://localhost/...` の宛先が残っていると、その `client_id` を知る攻撃者が被害者のブラウザで認可を走らせ、自分の手元で待ち受けるアプリへコードを届けられる。
- ポートのワイルドカード（RFC 8252 のループバック可変ポート）は**採用しない**。完全一致の例外を 1 つ作ると、それを認可時の比較へ持ち込むことになる。

認可時の照合は**バイト単位の完全一致のみ**で、正規化も末尾スラッシュの吸収もしない。クエリが 1 文字違えば別の宛先として扱う。

### 9.3 失効

```bash
pnpm --filter @u18/auth-worker client:disable --client-id u18-dashboard --remote
```

`disabled_at` が立つと、そのクライアントは即座に認可もトークン発行も拒否される（`ResolveOAuthClientUseCase` / `AuthenticateOAuthClientUseCase`）。`disabled_at is null` を条件に入れているので、二重に実行しても最初の失効時刻は上書きされない。

**失効してもトークンは自動では消えない。** 発行済みの Access Token / 同意（`oauth_grants`）は残るので、漏洩対応では併せて失効させること（§5.2 と同じ考え方）。

一覧は次で確認する。

```bash
pnpm --filter @u18/auth-worker client:list --remote
```

### 9.4 ローカル開発・E2E 用のシード

```bash
pnpm --filter @u18/auth-worker client:seed-dev
```

ローカル D1 に独立した 2 つのクライアント（confidential/first-party と public/third-party）を入れる。**2 つ必要なのは SSO の検証のため**で、1 つのブラウザセッションから複数クライアントへ続けてログインできることを確かめるには独立した `client_id` が 2 つ要る。

この 2 つを使った SSO の確認手順（自動テストの場所と、`wrangler dev` で手作業で
1 周する手順）は `tests/e2e/README.md` にある。

このシードの `client_secret` はスクリプト内に固定で書いてある。**`--remote` は受け付けない**ので本番には入らない。本番のクライアントは必ず §9.1 で登録し、生成された秘密を 1 度だけ受け取ること。

### 9.5 開発用の署名鍵

`.dev.vars.example` の `SIGNING_KEY_JWK` は placeholder で、そのままでは動かない。次で生成する（§2.4.1 の手順を、3 つの出力の取り違えが起きにくい形にまとめたもの）。

```bash
pnpm --filter @u18/auth-worker key:generate --apply-local
```

秘密鍵（`d` 入り）は `.dev.vars` へ貼り、公開鍵だけが `signing_key_metadata` に入る。`--apply-local` はローカル D1 への投入まで行う。**本番用の `--apply-remote` は用意していない。** 本番の鍵投入は「先に JWKS へ公開してから署名を切り替える」という時間差のある手順（§4.2）であり、1 コマンドで済ませてよい操作ではないため。

公開鍵の行を入れずに Worker を起動すると、`/.well-known/jwks.json` は **503**（`jwks_unavailable`）を返す。鍵が 1 本も無い状態で空の JWKS を 200 で返すと、RP がそれを正常な応答としてキャッシュし、鍵を入れ直してもキャッシュが切れるまで「鍵が無い」状態を信じ続けるため。

---

## 10. アカウント復旧

仕様書 §6.1 の「Passkey を失ったユーザーの復旧手順を公開前に定義する」と、§13 の受け入れ基準「アカウント復旧・削除・鍵ローテーションの運用が定義される」に対応する（#27）。鍵ローテーションは §4、削除は §11 にある。

### 10.1 最初に確定させるのは「メールを受け取れるか」

「ログインできない」という申告を受けたとき、Passkey を何本失ったかは二次的な情報である。**決めるのはメールアドレスの受信ができるかどうかだけ**で、そこで対応が 3 つに分かれる。

| 失ったもの                           | 自動で復旧できるか                   | 根拠                                                                |
| ------------------------------------ | ------------------------------------ | ------------------------------------------------------------------- |
| Passkey を全部（メールは受け取れる） | **できる。** 運用者の操作は要らない  | 仕様書 §14.1 決定 2（#34）。メール OTP が常にログイン経路として残る |
| メールアドレスへのアクセス           | **できない。コードに救済経路が無い** | §10.4。人手の審査に落とすしかない                                   |
| 管理者の Passkey                     | **自動化しない**（方針として）       | 仕様書 §14.1 決定 8（#40）。手順は §10.5                            |

申告を受けたら、案内する前に状態を引く。**症状が同じでも原因が違う。**

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 execute u18-identity --remote --command "
select u.id, u.username, u.status, u.email_verified,
       datetime(u.deleted_at/1000, 'unixepoch') as deleted_at,
       (select count(*) from passkeys p where p.user_id = u.id) as passkeys,
       (select count(*) from sessions s where s.user_id = u.id and s.revoked_at is null
          and s.expires_at > unixepoch() * 1000) as live_sessions
from users u where lower(u.primary_email) = lower('<メールアドレス>');
"
```

- `status` が `active` **かつ** `deleted_at` が NULL → 本節（§10）の復旧である。
- どちらかが外れている → これは復旧ではなく**凍結の解除**である。§11.5 へ行く。
- 行が返らない → そのアドレスのアカウントは存在しない。登録を案内する。**「アカウントが無い」と外部に伝えるのは、本人確認が取れた問い合わせ窓口の中だけにすること。** HTTP の応答は意図的にこの区別を隠してある（脅威モデル I-2）。

### 10.2 一般利用者が Passkey を全部失った場合

**これは障害ではない。設計どおりの経路が開いたままである。**

仕様書 §14.1 決定 2（#34）で初回登録に Passkey を必須にしないと決めたため、メール OTP は補助ではなく**常設のログイン経路**である。`DeletePasskeyUseCase` が最後の 1 本の削除を拒まないのも同じ根拠に立っている（`apps/auth-worker/src/application/use-cases/delete-passkey.use-case.ts` のコメント）。したがって「Passkey を全部失った」は、仕様上は締め出しではない。

手順:

1. §10.1 の SQL で `status = 'active'` / `deleted_at is null` を確認する。
2. **利用者自身にメール OTP でログインしてもらう。運用者が DB を触る必要は無い。**
3. ログインできたら、**その場で**新しい Passkey を登録してもらう。あとで、と言うと戻ってこない。
4. 残っている古い Passkey を棚卸しする。紛失・譲渡した端末のものは削除する（§5.2 手順 7 と同じ SQL）。

#### 本人確認として何を求めるか

**この経路では、運用者は追加の本人確認を行わない。** メールボックスの支配権がそのまま本人性の根拠になる。

これは決定 2 が明示的に受け入れた取引である（仕様書 §14.1 決定 8 の根拠欄: 「メール OTP はメールボックスの支配権がそのままアカウントの支配権になる。一般利用者にはこの取引が妥当でも……」）。**運用者が善意でこの経路を強めることはできない**し、強めてはならない。本人確認の追加を運用側だけで足すと、メールは届くのに人間の審査で止まる利用者が生まれ、決定 2 が保証しているはずの「常に開いている経路」が実質的に閉じる。

追加の確認が要るのは、**メール OTP が通らなかった場合**（§10.4）と**管理者**（§10.5）だけである。

#### うまくいかないときの観測可能な症状

**「送信しました」の表示は、送信された証拠にならない。** `StartEmailOtpUseCase` が実際にメールを出すのは `purpose = "login"` なら `user?.isActive === true` のときだけで、それ以外でも**応答を一切変えない**（アカウント列挙を塞ぐため。脅威モデル I-2）。凍結済みのアカウントでも、存在しないアドレスでも、画面は同じ `retryAfterSeconds` を返す。

区別は `audit_logs` でしか付かない。

```bash
npx wrangler d1 execute u18-identity --remote --command "
select datetime(created_at/1000, 'unixepoch') as at, outcome, reason, user_id, metadata
from audit_logs where event = 'otp.start' order by created_at desc limit 20;
"
```

| `outcome` / `reason`              | 意味                                                                | 次の行き先                      |
| --------------------------------- | ------------------------------------------------------------------- | ------------------------------- |
| `success`                         | 送信した。`user_id` が入る                                          | 届かないならメール到達性の問題  |
| `failure` / `no_eligible_account` | **送らなかった。** 凍結済み、または該当アカウントが無い             | §10.1 の SQL で状態を確定させる |
| `failure` / `resend_limit`        | 再送上限（直近 1 時間の行数）に当たった。§7.0 の `OtpPolicy` を参照 | 1 時間待つ。短縮する手段は無い  |

> **`no_eligible_account` の行には `user_id` が入らない。** 送らないと決めた時点ではアカウントを特定した情報を監査ログに残さない設計なので、**利用者を指定してこの行を引くことはできない。** 申告の時刻で窓を切って探すしかない。問い合わせ対応では「何時何分ごろに試したか」を必ず聞くこと。

Passkey が 1 本残っているのにログインできない場合は、**`passkey.login`** の `reason` を見る。`user_not_active` なら凍結である（`passkey-login-verify.use-case.ts`。HTTP には 401 として出るので、利用者から見た症状は「Passkey が拒否された」になり、凍結だと分からない）。

> **イベント名は `passkey.login` である。** 本書は長らく `passkey.login.verify` と書いていたが、**そのイベントは存在しない**（#147 で発見）。この名前で引いても 0 件しか返らず、「記録が無い」と読み違える。正しい名前の一覧は `AUDIT_EVENTS`（`apps/auth-worker/src/application/ports/audit-log.port.ts`）にある。

**`passkey.counter_regression` は別のイベントである**（#147）。署名カウンタの巻き戻し＝認証器の複製の疑いで、**利用者から見た症状は `user_not_active` と同じ 401** になる。切り分けるにはこちらも引くこと。

```sh
npx wrangler d1 execute u18-identity --env production --remote --command "
select created_at, user_id, reason from audit_logs
where event in ('passkey.login', 'passkey.counter_regression')
  and user_id = '<USER_ID>' order by created_at desc limit 20;
"
```

### 10.3 復旧後に既存のセッション・Passkey・grant をどう扱うか

**自動では何も消えない。** メール OTP でのログインは新しいセッションを 1 本増やすだけで、既存のセッション・Passkey・OAuth の同意（`oauth_grants`）はそのまま残る。

これは「認証器を失っただけ」なら正しい挙動だが、**「失った」と「盗られた」は申告の時点では区別できない。** 端末の紛失・盗難が疑われるなら、§5.2（アカウント侵害）の封じ込めを通すこと。判断は人間が行う。目安:

- 端末を紛失・盗難した、譲渡した、修理に出した → §5.2 を通す（セッション・grant・トークンを失効させ、Passkey を棚卸しする）
- 機種変更で古い端末を自分で初期化した → §10.2 だけでよい

### 10.4 メールアドレスにアクセスできなくなった場合

**現在のコードに救済経路は無い。** これは実装漏れではなく、まだ誰も設計していない領域である。

確認した事実:

- `PATCH /api/me` で変更できるのは `displayName` と `username` だけである（仕様書 §8.1）。**メールアドレスを変更する API は存在しない。**
- `user_emails` は複数アドレスを持てるスキーマだが、アドレスを追加・切り替える UseCase もルートも実装されていない。
- OTP の送信先は `users.primary_email` を引いた結果であり（`StartEmailOtpUseCase`）、別の宛先へ回す経路は無い。

つまり**運用者が DB を直接書き換える以外に手段が無い。** そして DB を書き換えられるのは Cloudflare アカウントを持つインフラ管理者だけである（§8.4 の運用課題 1）。

#### 何をもって本人と認めるか — 決める必要がある項目

**ここは現時点で未決である。** 以下は「決めるべき項目の一覧」であって、決定ではない。公開前に埋めること（§12.6 のチェックリストに入れてある）。

1. **本人確認の材料**。候補と、それぞれの弱点:
   - 既存の有効なセッションからの操作 — 最も強い。ただし全端末からログアウト済みなら使えない。
   - 残っている Passkey での署名 — 強い。ただし「Passkey もメールも失った」ケースには使えない。
   - 登録日時・最終ログイン時刻・登録済み Passkey の本数など、本人しか知らないはずの情報 — **弱い。** 当人が覚えていないことも多く、攻撃者が総当たりで当てられる粒度でもある。これ単独で通してはならない。
   - 対面確認（文化祭という運用形態では現実的な選択肢）。
2. **誰が承認するか**。単独承認を許すか、2 名承認を必須にするか。**本書は 2 名を推す。** メールアドレスの差し替えは「そのアカウントを別人に渡す」操作そのもので、ここを単独で通せるなら、インフラ管理者 1 名の判断で任意のアカウントを乗っ取れることになる。
3. **記録をどこに残すか**。§10.6 を参照。
4. **待機期間を置くか**。差し替えを実行する前に N 日の猶予を置き、その間は旧アドレスへ通知を送る、という設計が一般的である。**現在、通知を送る経路も「保留中の変更」を表現する列も無い**ので、導入するならスキーマ変更が要る。

#### 実行する場合の操作（承認が取れてから）

**先に §6.3 のエクスポートを取る。** メールアドレスの UNIQUE インデックスに触る操作であり、失敗すると復旧が面倒になる。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
# 1. 新アドレスが他のアカウントに使われていないことを確認する。
#    使われていれば UNIQUE 違反で UPDATE が落ちる（落ちるのは正しい挙動）。
npx wrangler d1 execute u18-identity --remote --command "
select id, status from users where lower(primary_email) = lower('<新アドレス>');
"
# 2. 差し替える。users.primary_email と user_emails の両方を直す。
#    一意性の正本は users.primary_email 側で、user_emails は確認状態の台帳である
#    （仕様書 7.1、packages/db/src/schema/users.ts）。片方だけ直すと、OTP は新アドレスへ
#    飛ぶのに「確認済みか」を台帳で見る処理は旧アドレスを見る、という食い違いが残る。
npx wrangler d1 execute u18-identity --remote --command "
update users set primary_email = '<新アドレス>', email_verified = 0, updated_at = unixepoch() * 1000
where id = '<USER_ID>';
update user_emails set email = '<新アドレス>', verified_at = null, updated_at = unixepoch() * 1000
where user_id = '<USER_ID>' and is_primary = 1;
"
```

**`email_verified` / `verified_at` を意図的に落としている。** 運用者が入力したアドレスは、まだ本人の到達性が確認されていない。落としておけば、本人が次にメール OTP でログインした時点で `VerifyEmailOtpUseCase` が `markEmailVerified` を呼んで立て直す。立てたまま渡すと、「誰も到達性を確かめていないアドレスが確認済みとして記録されている」状態が残る。

**`user_emails` の UNIQUE は部分インデックスである**（`verified_at is not null` の行だけが対象。`packages/db/src/schema/users.ts`）。一方 `users_primary_email_unique` は**無条件**なので、衝突を実際に止めるのはこちらである。手順 1 の確認を飛ばすと、UPDATE が `UNIQUE constraint failed: users.primary_email` で落ちる。落ちた場合、**2 文のうち 1 文目だけが成功している可能性がある**（D1 の `--command` に複数文を渡しても単一トランザクションにはならない）。落ちたら必ず両方の値を読み直して整合を確かめること。

3. **旧アドレスに紐づく未消費のチャレンジを潰す。** 旧メールボックスを握っている相手が、差し替え前に取ったコードを使えないようにする。

```bash
npx wrangler d1 execute u18-identity --remote --command "
update email_challenges set consumed_at = unixepoch() * 1000
where lower(email) = lower('<旧アドレス>') and consumed_at is null;
"
```

4. **全セッションを失効させる**（§5.2 手順 3）。差し替えの理由が乗っ取りだった場合に、攻撃者のセッションを残さない。

### 10.5 管理者の復旧 — 自動化しない

**決定**（仕様書 §14.1 決定 8 / #40）: 管理者は Passkey 必須。メール OTP 単独ではログインも復旧もできない。全 Passkey を失った管理者の復旧は自動化しない。

#### 何が強制されているか（#83 で実装済み）

以前この節にあった「**管理者を作るとメール OTP で入れてしまう**」という警告は、#83 で解消した。現在コードが強制するのは次の 4 つで、**どれもテストで固定してある**。

| 強制内容                                                         | どこで                                                   | 破ったときの応答                                |
| ---------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| 管理者のセッションは Passkey でしか発行されない                  | `IssueSessionUseCase`（判定は `User.permitsAuthMethod`） | `forbidden`。OTP 経路では `invalid_code` に畳む |
| 管理者は最後の Passkey を削除できない                            | `DeletePasskeyUseCase`（判定は `User.canRemovePasskey`） | 409 `conflict`                                  |
| Passkey が 1 本も無いアカウントに権限を与えられない              | `grantAdminSql` の `exists (select 1 from passkeys ...)` | 0 行（CLI が理由を表示して非 0 終了）           |
| 付与と同時に、Passkey 以外で張られた生きたセッションを失効させる | `revokeNonPasskeySessionsSql`（CLI が付与の直後に流す）  | —                                               |

**OTP 経路の失敗を `invalid_code` に畳んでいるのは意図的である。** 応答が変わると「このアドレスは管理者のものだ」が外から分かり、攻撃対象を絞る材料になる。

**「管理者」が今何を指すのかは変わっていない。** 管理者だけが叩けるアプリ上の機能は依然として 1 つも無く、実権を持つのはインフラ管理者（Cloudflare アカウントを持つ人）だけである（§8.4 運用課題 1）。#83 が足したのは**管理機能ではなく、管理機能より先に生まれてしまう「管理者という呼び名」のほうを安全にする仕組み**である。インフラ管理者の復旧は u18 Identity の問題ではなく Cloudflare アカウントの問題なので、本書の対象外である。Cloudflare 側の 2 要素認証と復旧コードの管理は、u18 の全 Secret・全 D1 への唯一の鍵であることを踏まえて扱うこと（§1.4 の blast radius 表は Secret 単位での影響しか書いていないが、**Cloudflare アカウントを失うことはその全部を同時に失うことである**）。

#### 管理権限を与える

公開 UI は作らない（#13 の `oauth-client.mjs` と同じ方針）。唯一の経路は CLI である。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
# 1. 状態を見る。Passkey の本数と、生きている OTP セッションの数が出る。
node scripts/admin-role.mjs status --user-id '<USER_ID>' --remote
# 2. 付与する。--actor は監査ログに残る実行者の識別子（メールアドレスや本名は入れない）。
node scripts/admin-role.mjs grant --user-id '<USER_ID>' --actor '<GitHub ハンドル>' --remote
```

- **Passkey が 1 本も無いと付与されない。** 先に本人へ Passkey を登録させること。登録はアカウント画面から本人が行う操作で、運用者の出番は無い。
- **2 本以上を登録させること。** 1 本しか無い管理者は、その 1 本を外せない（上の表の 2 行目）。盗まれた端末の認証器を外すには、先に別の認証器を足す必要がある。
- 付与は `status = 'active'` かつ論理削除されていないアカウントにしか通らない。凍結解除と同時に管理者が復活する形を作らないため（決定 7）。
- 剥奪は `node scripts/admin-role.mjs revoke --user-id ... --actor ... --remote`。**前提条件は無い** —— 権限を減らす操作はいつでも通る。
- `--dry-run` を付けると、流す SQL を表示するだけで実行しない。レビューや記録に残したいときに使う。

#### 全 Passkey を失った管理者の復旧

**自動化しない**（仕様書 §6.1 / §14.1 決定 8）。ただし**専用の救済コードも書かない。** 手順は「いったん一般利用者に戻してから、通常の経路で登録し直させる」である。

1. **状態を引く**（§10.1 の SQL）。`is_admin` が立っていること、`passkeys` が 0 本であることを確かめる。メールアドレスにも到達できないなら、先に §10.4 を通すこと。
2. **審査する。** 決めるべき項目は §10.4 の 4 つ（本人確認の材料・承認者・記録・待機期間）と同じだが、**管理者については 2 名承認を必須とする。** §10.4 が一般利用者について「推す」と書いた水準を、ここでは必須に上げる —— この手順は実質的に「決定 8 の保護を一時的に外す」操作であり、単独で通せるなら、インフラ管理者 1 名の判断で管理者アカウントを別人に渡せることになる。本人確認の材料は**残っているセッションか対面確認を優先**する。登録日時のような「本人しか知らないはずの情報」は単独で通してはならない（§10.4）。
3. **権限を剥奪する。** ここまでが審査であり、ここから先は通常の経路である。

   ```bash
   node scripts/admin-role.mjs revoke --user-id '<USER_ID>' --actor '<承認者 2 名が分かる識別子>' --reason 'passkey_lost_recovery' --remote
   ```

4. **本人が通常どおりメール OTP でログインし、Passkey を登録し直す。** 権限が落ちているので決定 8 の制約は掛からない。**運用者の操作は要らない。**
5. **失った認証器の行を掃除する**（残っていれば）。`ops.passkeys.purged` を §10.6 の形で記録すること。
6. **付与し直す。**

   ```bash
   node scripts/admin-role.mjs grant --user-id '<USER_ID>' --actor '<実行者>' --reason 'passkey_lost_recovery' --remote
   ```

   手順 4 が終わっていなければ、ここは 0 行で終わる（Passkey が無いので付与条件を満たさない）。**順序を守れているかを CLI が勝手に確かめてくれる**ので、確認を手順書の注意書きに頼らずに済む。

**この手順の弱点を正直に書いておく。** 手順 3 と 4 の間、そのアカウントはメール OTP で入れる普通のアカウントである。つまり**メールボックスを握った相手がこの窓で入れる。** 窓を閉じているのは技術ではなく手順 2 の承認であり、だからこそ 2 名承認を必須にしている。窓を短くするため、手順 3 から 6 は一度の作業として続けて行うこと —— 剥奪したまま放置しない。

### 10.6 復旧操作の監査証跡

**`wrangler d1 execute` による操作は `audit_logs` に何も残さない。** 監査ログを書くのは Worker のコードであり、DB を直接触る経路はそれを通らない。したがって **§10.4 のような人手の復旧は、運用者が自分で行を足さない限り痕跡が残らない。**

`audit_logs.event` は enum ではなく自由な `text` 列なので（`packages/db/src/schema/audit.ts`）、運用側のイベント名を足せる。復旧操作では必ず記録すること。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 execute u18-identity --remote --command "
insert into audit_logs (id, event, user_id, actor, outcome, reason, metadata, created_at)
values (
  'aud_' || lower(hex(randomblob(16))),
  'ops.account.recovered',
  '<USER_ID>',
  '<実行者の識別子>',
  'success',
  'email_access_lost',
  json_object('approvedBy', '<承認者>', 'method', '<本人確認の方法>', 'ticket', '<記録の所在>'),
  unixepoch() * 1000
);
"
```

**`id` と `created_at` には SQL レベルの DEFAULT が無い**（`packages/db/drizzle/0000_fat_thunderbird.sql`。既定値は Drizzle が JS 側で入れている）。省くと `NOT NULL constraint failed: audit_logs.id` もしくは `audit_logs.created_at` で落ちる。`created_at` は epoch **ミリ秒**なので `* 1000` を忘れないこと（付録 B）。

記録するイベント名の候補（運用側の接頭辞を `ops.` で揃える。アプリが書くイベントと混ざらないようにするため）:

| イベント                  | いつ                                               |
| ------------------------- | -------------------------------------------------- |
| `ops.account.recovered`   | メールアドレスの差し替えなど、人手の復旧を実行した |
| `ops.account.disabled`    | 凍結した（§11）                                    |
| `ops.account.reactivated` | 凍結を解除した（§11.5）                            |
| `ops.passkeys.purged`     | 運用者が Passkey を削除した                        |
| `ops.admin.granted`       | 管理権限を付与した（§10.5。CLI が自動で書く）      |
| `ops.admin.revoked`       | 管理権限を剥奪した（§10.5。CLI が自動で書く）      |

**`metadata` に秘密を入れないこと。** トークン・OTP・生 IP・メールアドレスは入れない（`audit-log.port.ts`）。承認者やチケット番号は秘密ではないので入れてよい。**メールアドレスの差し替えでは、旧アドレスも新アドレスも `metadata` に書かない。** アドレスそのものはチケット側に置き、ここにはその所在だけを書く。

**この記録は改竄を防がない。** 同じ権限で UPDATE も DELETE もできる（脅威モデル T-4）。目的は「後から辿れること」であって「否認できないこと」ではない。否認防止が要るなら、Cloudflare の外に追記専用の記録を置く必要がある —— これは未整備である。

---

## 11. アカウント削除（＝凍結）

### 11.1 前提 — 物理削除はしない

**決定**（仕様書 §14.1 決定 7）: アカウントは物理削除しない。利用者から見た「削除」は、行を残して `status` を変える**凍結 / BAN / 無効化**として実装する。結果として**メールアドレスは解放されず、同じアドレスでの再登録はできない。**

根拠は監査ログとの整合、誤削除からの復旧、不正利用者の再登録防止である。

**この決定は既に実装側が満たしている。** `User.isActive`（`apps/auth-worker/src/domain/entities/user.ts`）は

```ts
get isActive(): boolean {
  return this.props.status === "active" && this.props.deletedAt === null;
}
```

であり、`status` と `deleted_at` の**両方**を見る。どちらか一方を立てれば認証は止まる。

> **§7.1「スキーマ上の前提」には「認証の遮断に効くのは `status` だけ」と書かれていた時期がある。** それは既に正しくない。§7.1 側も訂正してあるが、古い印刷物やコピーを持っている場合は本節の記述を優先すること。

`status` の使い分けは次のとおり。**どちらも `isActive` を同じように倒すので認証への効果は変わらない**が、後の判断材料として区別する。

| 状況                             | `status`    | `deleted_at` | なぜ区別するか                                                             |
| -------------------------------- | ----------- | ------------ | -------------------------------------------------------------------------- |
| 利用者本人からの「削除」依頼     | `deleted`   | 立てる       | §11.6 の保持期間の方針が決まったとき、対象になるのはこちらだけ             |
| 侵害の疑いによる緊急停止（§5.2） | `suspended` | NULL のまま  | 本人に返す前提の一時停止。復帰が前提なので削除の対象に混ぜない             |
| 規約違反による BAN               | `suspended` | NULL のまま  | 再登録を防ぐために行を残すのが目的。個人情報を落とす対象に混ぜてはならない |

### 11.2 手順

セルフサービスの削除 API は存在しない（`PATCH /api/me` も `displayName` / `username` しか受け付けない）。**現時点では運用者が手で実行する。**

#### ステップ 1 — 本人確認を行う

§5.2 手順 9 と同等。凍結は 1 行の UPDATE で取り消せるが（§11.5）、**なりすましによる凍結は、その間ずっと正規の利用者を締め出す。** 可用性への攻撃として成立する。

#### ステップ 2 — ブックマークを取り、現在の状態を記録する

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 time-travel info u18-identity          # 出力を記録に残す（§12.2）
npx wrangler d1 execute u18-identity --remote --command "
select id, username, status, email_verified,
       datetime(created_at/1000, 'unixepoch') as created_at,
       datetime(deleted_at/1000, 'unixepoch') as deleted_at
from users where lower(primary_email) = lower('<メールアドレス>');
"
```

#### ステップ 3 — 凍結する

```bash
npx wrangler d1 execute u18-identity --remote --command "
update users
set status = 'deleted', deleted_at = unixepoch() * 1000, updated_at = unixepoch() * 1000
where id = '<USER_ID>' and deleted_at is null;
"
```

**`deleted_at is null` を条件に残す理由**: 二重実行で `deleted_at` が上書きされると、保持期間の起点が後ろへずれる。保持期間の方針が決まったとき（§11.6）、この列が起点になる。

**凍結しても `is_admin` は落ちない。** 凍結中はログインできないので実害は出ないが、§11.5 で凍結を解除した瞬間に管理者として戻る。**凍結の理由が侵害の疑いなら、凍結の前に §10.5 の `revoke` で権限を落とすこと。**

時刻は epoch **ミリ秒**。`unixepoch()` をそのまま入れると 1970 年になり、`deleted_at` が過去になるので保持期間の判定が即座に満了扱いになる（付録 B）。

#### ステップ 4 — セッションを一括失効させる

`status` を倒した時点で `GetSessionUseCase` が全セッションを拒否するようになるが（`user.isActive` を毎回確認している）、**行の状態も合わせておく。** 揃えておかないと、凍結を解除した瞬間に古いセッションが一斉に生き返る。

```bash
npx wrangler d1 execute u18-identity --remote --command "
select count(*) from sessions where user_id = '<USER_ID>' and revoked_at is null;
"
npx wrangler d1 execute u18-identity --remote --command "
update sessions set revoked_at = unixepoch() * 1000
where user_id = '<USER_ID>' and revoked_at is null;
"
```

**一括 UPDATE の前に同じ `where` で `count(*)` を取ること**（付録 B 規則 5）。件数が想定と桁違いなら `user_id` を取り違えている。

#### ステップ 5 — 同意・トークン・未消費のコードを潰す

§5.2 の手順 4・5・6 と同じ SQL をそのまま実行する。重複して書かない —— 同じ SQL が 2 箇所にあると、片方だけが直される。

**`oauth_grants.revoked_at` を立てても `oauth_tokens` は自動失効しない。** 外部キーの `onDelete: cascade` は行の削除にしか効かず、`revoked_at` の更新には連動しない。両方を明示的に実行すること。

#### ステップ 6 — NFC カードを止める

> **これは #92 で NFC が入ってから必要になった手順で、§7.1 には書かれていない。**

`nfc_cards.owner_user_id` には**外部キーが無い**（`u18-nfc` は別 D1 なので張れない。`packages/nfc-db/src/schema/cards.ts`）。そして `ResolveCardUseCase` は**所有者の生死を見ない** —— 1 タップごとに Identity へ RPC を飛ばすと NFC 側の負荷が Identity の障害になるため、意図的にそうしてある。

**結果として、アカウントを凍結しても、その人の NFC カードはタップされ続け、遷移先へリダイレクトし続ける。** 止めるには NFC 側を明示的に倒すしかない。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/nfc-worker
npx wrangler d1 execute u18-nfc --remote --command "
select id, status, target_url, datetime(claimed_at/1000, 'unixepoch') as claimed_at
from nfc_cards where owner_user_id = '<USER_ID>';
"
npx wrangler d1 execute u18-nfc --remote --command "
update nfc_cards
set status = 'disabled', disabled_at = unixepoch() * 1000,
    disabled_reason = 'ops', updated_at = unixepoch() * 1000
where owner_user_id = '<USER_ID>' and status <> 'disabled';
"
```

NFC 側の証跡は `audit_logs` ではなく `nfc_card_events` に入る（別 D1 なので当然だが、**インシデント調査で片方しか見ない事故が起きやすい**）。手で足す場合は ID 接頭辞が `nev_`、`created_at` はここでも DEFAULT 無しの NOT NULL である。

```bash
npx wrangler d1 execute u18-nfc --remote --command "
insert into nfc_card_events (id, card_id, event, actor_user_id, metadata, created_at)
select 'nev_' || lower(hex(randomblob(16))), id, 'card.disabled', null,
       json_object('reason', 'owner_account_disabled'), unixepoch() * 1000
from nfc_cards where owner_user_id = '<USER_ID>';
"
```

**無効化は片道である。** `DisableCardUseCase` の設計上、所有者は自分で戻せない（紛失対策としての意味を保つため）。誤って止めた場合の復帰は §11.5 に含めてある。

#### ステップ 7 — Passkey は、この時点では消さない

> **§7.1 手順 6 は「論理削除の猶予期間を待たずに消してよい」としている。本節はそうしない。**
>
> §7.1 のその手順は**物理削除を前提にした流れの一部**として書かれたものである。決定 7 で物理削除をしないと決めた以上、「どうせ後で消える行だから先に消してよい」という前提が無くなっている。
>
> **凍結は 1 行の UPDATE で取り消せるが、`delete from passkeys` は取り消せない**（Time Travel の 30 日窓の中でしか戻せず、戻すと他の全テーブルも巻き戻る。§12.4）。誤凍結や撤回の申し出が現実に起きる以上、取り消せる操作と取り消せない操作を同時に実行する理由は無い。

猶予は **30 日**とする。Time Travel の窓（§12.2）と揃えてあり、「戻せる期間」と「戻す手段がある期間」が一致する。

30 日経過後:

```bash
npx wrangler d1 execute u18-identity --remote --command "
select u.id, datetime(u.deleted_at/1000, 'unixepoch') as deleted_at,
       (select count(*) from passkeys p where p.user_id = u.id) as passkeys
from users u
where u.status = 'deleted' and u.deleted_at is not null
  and u.deleted_at < (unixepoch() - 30 * 86400) * 1000;
"
npx wrangler d1 execute u18-identity --remote --command "
delete from passkeys where user_id = '<USER_ID>';
delete from webauthn_challenges where user_id = '<USER_ID>';
delete from email_challenges where user_id = '<USER_ID>';
"
```

`status = 'deleted'` を条件に入れているのは、**`suspended`（BAN・緊急停止）を巻き込まないため**である。§11.1 の表のとおり、`deleted_at` が立つのは本人依頼の削除だけだが、将来この列を別の用途に使う実装が入ったときに備えて `status` も見ておく。

#### ステップ 8 — 記録する

§10.6 の形式で `ops.account.disabled` を 1 行入れる。**依頼者・確認方法・実行者・実行日時**を残す。

### 11.3 凍結後に何が起きるか

| 操作                         | 結果                                                                       | どこで止まるか                                                                          |
| ---------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 既存セッションでのアクセス   | 即座に拒否される                                                           | `GetSessionUseCase` が毎回 `user.isActive` を見る                                       |
| メール OTP の送信要求        | **メールが届かない。画面は成功と区別が付かない**                           | `StartEmailOtpUseCase` の `shouldSend`（§10.2）                                         |
| Passkey でのログイン         | 401。`audit_logs` に `passkey.login` / `user_not_active`                   | `PasskeyLoginVerifyUseCase`                                                             |
| セッション発行（最後の砦）   | `forbidden`。`audit_logs` に `session.issue` / failure / `user_not_active` | `IssueSessionUseCase`                                                                   |
| OAuth のトークン発行         | セッションが無いので認可フローに入れない                                   | 同上                                                                                    |
| 同じメールアドレスでの再登録 | **できない**                                                               | `users_primary_email_unique`（`lower(primary_email)` の**無条件** UNIQUE インデックス） |
| NFC カードのタップ           | **止まらない。明示的に倒すまでリダイレクトし続ける**                       | §11.2 ステップ 6                                                                        |

**`IssueSessionUseCase` の `user_not_active` は多重防御であって、通常は手前で止まる。** 確認した事実として、メール OTP 経路（`VerifyEmailOtpUseCase`）も Passkey 経路（`PasskeyLoginVerifyUseCase`）も、`IssueSessionUseCase` を呼ぶ前に自分で `isActive` を見ている。`session.issue` / `user_not_active` の行が `audit_logs` に出たら、**どちらのチェックも通り抜けた呼び出し元がいる**ということなので、新しい認証経路の実装ミスを疑うこと。

**メールアドレスが解放されないことは、利用者から必ず問い合わせが来る。** 「削除したのに同じメールで作り直せない」は決定 7 の意図した結果であり、不具合ではない。応対の文言を決めておくこと（§11.6）。

### 11.4 凍結されたアカウントのデータは、どこまで残るか

残る（凍結では消えない）もの:

- `users` の行すべて —— `username`、`display_name`、`primary_email`
- `user_emails` の行
- `passkeys`（§11.2 ステップ 7 の 30 日猶予を過ぎるまで）
- `audit_logs` の `user_id` / `ip_hash` / `user_agent` —— **180 日の保持期間（§7.0）に従って消えるが、`users` の凍結とは無関係に動く**
- `nfc_cards.owner_user_id` —— 別 D1 なので Identity 側の操作では一切変化しない

自動で消えるもの:

- `sessions` —— 失効から 30 日後に Cron が消す（§7.0）
- `email_challenges` —— 1 時間（**平文のメールアドレスを持つ唯一のテーブル**）
- `webauthn_challenges` / `oauth_authorization_codes` —— 24 時間

**`users` は §7.0 の自動削除の対象外である**（`RetentionPolicy` に `users` のエントリが無い）。これは意図的で、保持期間が決まっていないのに自動削除の経路を先に作ると、方針より先に実装が既成事実になるためである。

### 11.5 誤って凍結した場合の復帰手順

**凍結の取り消しは可逆である。** ステップ 7 の Passkey 削除を実行していない限り、元の状態に戻せる。Time Travel による巻き戻しは**使わない**（他の全テーブルを巻き込むため。§12.4）。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
# 1. 状態を戻す。deleted_at も必ず NULL に戻す。
#    status だけ戻すと isActive は false のままで、症状が変わらない。
npx wrangler d1 execute u18-identity --remote --command "
update users
set status = 'active', deleted_at = null, updated_at = unixepoch() * 1000
where id = '<USER_ID>';
"
# 2. 戻ったことを確認する。
npx wrangler d1 execute u18-identity --remote --command "
select id, status, deleted_at from users where id = '<USER_ID>';
"
```

**セッションは戻さない。** ステップ 4 で失効させたセッションは失効したままにする。「誤凍結だった」は「それらのセッションが安全だった」を意味しない（凍結の理由が侵害の疑いだった可能性がある）。利用者にはログインし直してもらう。

**OAuth の同意（`oauth_grants`）も戻さない。** 同じ理由で、再同意してもらうほうが安全である。復帰直後に各アプリで同意画面が出ることを、利用者に先に伝えること。

NFC カードを止めていた場合（ステップ 6 を実行済み）:

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/nfc-worker
npx wrangler d1 execute u18-nfc --remote --command "
update nfc_cards
set status = 'active', disabled_at = null, disabled_reason = null, updated_at = unixepoch() * 1000
where owner_user_id = '<USER_ID>' and status = 'disabled'
  and disabled_reason = 'ops' and owner_user_id is not null and target_url is not null;
"
```

**`disabled_reason = 'ops'` を条件に入れること。** これを外すと、**利用者が自分で「紛失した」として止めたカード（`reason = 'lost'`）まで復活させてしまう。** 紛失報告を無効化する操作であり、拾った人間の手でリダイレクトが生きる。`target_url is not null` も必須で、未設定のカードを `active` にすると `isResolvable()` の前提が崩れる（解決時に `card_not_found` へ落ちるので実害は出ないが、状態として嘘になる）。

**復帰させたら `ops.account.reactivated` を記録する**（§10.6）。凍結と復帰が対で残っていないと、あとで「この利用者は一度凍結されている」という事実だけが見えて理由が辿れない。

### 11.6 未解決の論点 — 「削除しました」と言えるか

**これは本節で解決していない。判断待ちとして記録する。**

#### 問題

仕様書 §9 Privacy は「情報公開範囲、削除・保持期間を明示」を要求している。一方、決定 7 により凍結アカウントは物理削除されず、**凍結アカウントの保持期間はまだ決まっていない**（仕様書 §14.2 未決定 2）。§7.0 の自動削除（#43）は `users` を意図的に対象外にしている。

つまり現状は、**利用者に「削除しました」と伝えながら、氏名相当（`username` / `display_name`）とメールアドレスを無期限に保持する**状態である。この状態のまま公開することはできない。

#### どちらかが要る

**(a) 凍結から N 日後に個人情報を落とす経路を作る**

行は残したまま、個人情報だけをトゥームストーン化する。再登録防止（決定 7 の根拠の 1 つ）はメールアドレスのハッシュを別列に持てば維持できるが、**その列は現在のスキーマに存在しない。** 実装を伴う。

落とす対象: `users.username` / `users.display_name` / `users.primary_email` / `user_emails.email`、および `audit_logs` の `user_id` / `ip_hash` / `user_agent`。

**最後の 1 つは監査証跡そのものを失う操作である。** `audit_logs.user_id` は外部キーではない `text` 列で、ユーザーを消しても証跡が残るよう意図的にそうしてある（`packages/db/src/schema/audit.ts`）。「削除要求への対応」と「セキュリティ証跡の保全」は正面から衝突しており、どちらを取るかは本書が決められる範囲を超えている。

**(b) 利用者への表示を「削除」ではなく「無効化」と正確に伝える**

UI と問い合わせ応対の文言を変える。実装は要らないが、**「アカウントを削除する」というボタンを置けなくなる。** 併せて、メールアドレスが解放されないこと（§11.3）も明示する必要がある。

#### 現時点の運用

**決まるまでは (b) に寄せて応対すること。** つまり、利用者には「アカウントを無効化し、ログインできない状態にした」と伝え、「データを消した」とは**言わない**。既に「削除」と伝えてしまった利用者がいる場合は、方針決定後に訂正の連絡が要る。記録を §10.6 の形で残しておくこと。

この判断は #27 / #51 / #43 と仕様書 §14.2 の未決定 2 に紐づく。**公開前に決着させる必要がある**ので、§12.6 のチェックリストに入れてある。

---

## 12. バックアップと復旧の運用（#27）

> **§6 を置き換えるものではない。** §6 は D1 の保護手段（Time Travel / エクスポート）と復旧リハーサルの手順を定めている。本節はそこに、**#92 で D1 が 2 つになったこと**、**Time Travel について実際に確認した事実と確認できなかった事実の区別**、**D1 以外に失うと困るもの**を足す。

### 12.1 守る対象は 3 つある

| 対象              | 保護手段                                     | 失ったときに起きること                                            |
| ----------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| D1 `u18-identity` | Time Travel（30 日）+ `wrangler d1 export`   | 全ユーザーのログイン不能。OIDC を利用する全サービスが同時に止まる |
| D1 `u18-nfc`      | 同上（**別データベースなので別操作が要る**） | NFC カードが解決しなくなる。Identity は無事なのでログインは通る   |
| Workers Secret    | **何も無い。読み出す手段が存在しない**       | §12.5                                                             |

**D1 が 2 つになったのは #92 からである。** `u18-nfc` は `apps/nfc-worker/wrangler.jsonc` の `NFC_DB` バインディングが指す独立したデータベースで、`u18-identity` とは別のマイグレーションディレクトリ（`packages/nfc-db/drizzle`）を持つ。

**§6.2 / §6.3 / §6.4 の手順は `u18-identity` しか対象にしていない。** そのまま実行すると NFC 側が保護されない。本節のコマンドは両方を回す形で書いてある。

```bash
# 両方のエクスポート（§6.3 の手順を 2 DB へ広げたもの）
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 export u18-identity --remote \
  --output "/secure/backups/u18-identity-$(date -u +%Y%m%dT%H%M%SZ).sql"
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/nfc-worker
npx wrangler d1 export u18-nfc --remote \
  --output "/secure/backups/u18-nfc-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

**2 つのエクスポートは、できるだけ近い時刻に取ること。** 後述のとおり 2 つの DB の間に整合を保証する仕組みが無いため、取得時刻が離れるほど復元後のずれが大きくなる。

> `u18-nfc` のダンプの機密性は `u18-identity` より低いが、**ゼロではない。** `nfc_cards.owner_user_id` は Identity の `sub` そのもので、`target_url` と組み合わせると「誰がどこへのリンクを配っているか」が分かる。§6.3「エクスポートファイルの取り扱い」の 5 項目は両方に適用する。

### 12.2 D1 Time Travel — 確認した事実

以下は **Cloudflare の公式ドキュメントと、リポジトリに入っている wrangler 4.152.0 の `--help` 出力**で確認した内容である。**実際の復元は実行していない**（§12.6）。

#### 確認できた事実

| 項目                      | 内容                                                                                                       | 確認方法                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 保持期間                  | **Workers Paid で 30 日、Workers Free で 7 日**                                                            | Cloudflare docs（Time Travel / D1 limits）          |
| 有効化                    | 自動。設定も追加費用も不要                                                                                 | Cloudflare docs                                     |
| サブコマンド              | `info` と `restore` の **2 つだけ**                                                                        | `wrangler d1 time-travel --help`                    |
| `info` のオプション       | `--timestamp`（Unix 秒 または RFC3339）、`--json`                                                          | `wrangler d1 time-travel info --help`               |
| `restore` のオプション    | `--bookmark`、`--timestamp`（**直近 30 日以内**）、`--json`                                                | `wrangler d1 time-travel restore --help`            |
| 対象                      | **リモート D1 のみ。** `--remote` / `--local` フラグが無く、ローカルの miniflare D1 には使えない           | 同上（"This command acts on remote D1 Databases."） |
| 復元の性質                | **その場で上書きする（in-place）。** 新しい DB は作られない                                                | Cloudflare docs                                     |
| 復元の取り消し            | 復元しても古いブックマークは消えない。復元の出力に**復元前の状態を指すブックマーク**が含まれ、それで戻せる | Cloudflare docs                                     |
| 実行中のクエリ            | **復元時に進行中のクエリ・トランザクションはキャンセルされ、クライアントにはエラーが返る**                 | Cloudflare docs                                     |
| 復元の回数制限            | **10 分あたり 10 回まで（DB ごと）**                                                                       | Cloudflare docs（D1 limits）                        |
| 30 日より前のブックマーク | 復元ポイントとして無効                                                                                     | Cloudflare docs                                     |
| 複製・fork                | **サポートされていない**（「予定」とされている）                                                           | Cloudflare docs                                     |
| 旧 alpha DB               | Time Travel 非対応。`wrangler d1 info` の `version` が `production` であることが前提                       | Cloudflare docs                                     |

> **`wrangler d1 time-travel --help` の説明文は "restore, **fork or copy** a database" と書いているが、`fork` / `copy` に相当するサブコマンドは存在しない**（`info` と `restore` だけ）。Cloudflare のドキュメントも複製・fork は未サポートとしている。**「本番を fork してリハーサル用 DB を作る」計画は立てられない。** §6.4 のリハーサルが「別の D1 を作ってエクスポートを流し込む」形になっているのはこのためである。

#### 確認できなかったこと（未確認）

- **復元の所要時間。** ドキュメントに記載が無く、実測もしていない。`u18-identity` / `u18-nfc` の実サイズでどれだけかかるかは不明である。RTO の見積もりはこの数字が出るまで立てられない。
- **復元中にデータベースが読み書き可能かどうか。** 「進行中のクエリがキャンセルされる」ことは確認できたが、復元が完了するまでの間に新しいクエリが通るのか、エラーになるのかは**未確認**である。復元を本番で実行するなら、ダウンタイムが発生するものとして告知すること。
- **削除済みデータベースに対して Time Travel が使えるかどうか。** ドキュメントに記載が無い。**`wrangler d1 delete` を「あとで戻せる」と考えないこと。**
- **復元が `d1_migrations` テーブルをどう扱うか。** `d1_migrations`（wrangler が適用済みマイグレーションを記録する既定のテーブル名。本リポジトリは `migrations_table` を上書きしていない）は DB 内の通常のテーブルなので、復元すれば一緒に巻き戻るはずである。**ただし実際に確認していない。** 復元後は必ず `wrangler d1 migrations list` で状態を見ること（§12.4）。
- **復元の出力に含まれるブックマークの正確な形式**。ドキュメントは例として `00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683` を挙げているが、これが保証された形式かどうかは記述が無い。**出力はパースせず、そのまま記録に貼ること。**

### 12.3 復元の実行

**ブックマークは危険な操作の直前に取る。** 取り忘れると時刻指定に頼ることになり、戻る先が「おおよそ」になる。

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 time-travel info u18-identity --json | tee -a /secure/ops/bookmarks.log
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/nfc-worker
npx wrangler d1 time-travel info u18-nfc --json | tee -a /secure/ops/bookmarks.log
```

復元:

```bash
# Identity
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 time-travel restore u18-identity --bookmark <BOOKMARK>
# NFC
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/nfc-worker
npx wrangler d1 time-travel restore u18-nfc --bookmark <BOOKMARK>
```

**実行前に必ず現在時点のブックマークも取ること。** 復元を取り消したくなったときに要る（復元の出力にも復元前を指すブックマークが含まれるが、出力を取り損ねる事故が起きる。先に `info` を取っておけば二重に保険が効く）。

**時刻指定で戻る場合、どちらの DB にも同じ時刻を渡すこと。** 2 つの DB の間にトランザクションは無く、ブックマークにも対応関係が無い。**同じ時刻を指定しても、2 つの DB が厳密に同じ瞬間へ揃う保証は無い**（ブックマークは DB ごとの書き込み履歴上の点であり、クロックの粒度も未確認である）。これは受け入れるしかないずれで、§12.4 の最後の項目がその帰結である。

### 12.4 復元すると何が壊れるか

§6.2 が「復元によって失われるもの」を列挙している。本節はそこに **#92 以降に増えたもの**と、**見落としやすい連鎖**を足す。

#### (1) 失効させたはずのセッションが復活する

§6.2 が既に指摘しているとおり、これが最も危険である。インシデント対応でセッションを失効させた後に巻き戻すと、**攻撃者のセッションが生き返る。** 復元後は必ず §5.2 の封じ込めをやり直す。

同じことが §11 の凍結にも起きる。**復元時点より後に凍結したアカウントは `status = 'active'` に戻り、ログインできる状態に復活する。** 復元後、`ops.account.disabled` の記録（§10.6）と `users.status` を突き合わせて、凍結がすべて効いているかを確認すること。**その記録自体も `audit_logs` にあるので一緒に巻き戻っている** —— 手元の運用記録（チケット側）と突き合わせるしかない。

#### (2) 署名鍵のメタデータが巻き戻り、全 ID Token の検証が失敗する

**§6.2 に書かれていない、この系に固有の壊れ方である。**

`signing_key_metadata` は D1 のテーブルだが、対になる秘密鍵は **Workers Secret の `SIGNING_KEY_JWK`** にある（§4.1）。Time Travel は D1 しか戻さないので、**鍵ローテーション（§4.2）より前へ巻き戻すと、DB は旧 kid の行しか持たないのに Secret は新しい秘密鍵のまま**になる。

症状: ID Token のヘッダが新しい `kid` を名乗るのに、`/.well-known/jwks.json` にその kid が無い。**全 RP で ID Token の検証が失敗する。** §4.1 の制約 3 で挙げた「DB と Secret の不一致」が、ローテーションの操作ミスではなく復元によって起きる形である。

復元後の確認（§4.2 ステップ 6 と同じ）:

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 execute u18-identity --remote --command "
select kid, datetime(active_from/1000, 'unixepoch') as active_from,
       datetime(active_until/1000, 'unixepoch') as active_until,
       datetime(retires_at/1000, 'unixepoch') as retires_at
from signing_key_metadata order by active_from;
"
npx wrangler secret list   # SIGNING_KEY_KID が設定されていることだけは分かる（値は見えない）
curl -s https://<auth-worker-の-URL>/.well-known/jwks.json | jq '.keys[].kid'
```

**`wrangler secret list` では値が見えない**ので、一致の確認は「ID Token を 1 本発行してヘッダの `kid` を見る」か「現役の kid を確かめたうえで Secret を入れ直す」しかない。迷ったら**入れ直すほうが速い** —— §4.2 ステップ 4 の 2 コマンドで、鍵ペアを生成し直すところからやる。

**逆方向（鍵漏洩対応の後に巻き戻す）はさらに悪い。** §5.1 で JWKS から外したはずの漏洩鍵が、`signing_key_metadata` に復活して再び公開される。偽造トークンがまた通るようになる。**鍵漏洩対応の後は、Time Travel でその時点より前へ戻さないこと。** どうしても戻す必要があるなら、復元の直後に §5.1 の手順 3（漏洩 kid の `retires_at` を過去にして DELETE）をもう一度実行する。

#### (3) マイグレーション状態が巻き戻る

`d1_migrations` は DB 内の通常のテーブルなので、復元すれば一緒に戻る**はずである（未確認、§12.2）**。マイグレーション適用より前へ戻すと、スキーマと `d1_migrations` が揃って巻き戻るので整合はするが、**デプロイ済みのコードは新しいスキーマを前提にしている。** 症状は `no such column` 系のエラーである。

復元後に必ず確認する:

```bash
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 migrations list u18-identity --remote
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/nfc-worker
npx wrangler d1 migrations list u18-nfc --remote
```

未適用のものが出たら、コードを戻す（`wrangler rollback`）か、マイグレーションを再適用するかを選ぶ。**§3.1.3 の「マイグレーションはコードより先」は復元後にも効く。**

#### (4) 監査ログが欠ける

復元時点以降の `audit_logs` が消える。**インシデント対応の最中に復元すると、その対応自体の証跡が消える。** §5 の共通初動が「対応中の DB 操作はすべて実行文ごと記録に残す」としているのは、DB の外に記録を持つためである。復元を伴う対応では、この手元の記録が唯一の証跡になる。

#### (5) 2 つの D1 がずれ、`nfc_cards.owner_user_id` が存在しないユーザーを指す

**#92 以降に生じた壊れ方である。**

`u18-identity` と `u18-nfc` は別のデータベースで、**外部キーで結べない**（`packages/nfc-db/src/schema/cards.ts` に理由が書いてある）。片方だけを巻き戻すと、次の 2 つが起きうる。

| 巻き戻した側        | 起きること                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `u18-identity` だけ | `nfc_cards.owner_user_id` が、**巻き戻しで消えたユーザーを指す**。そのカードは誰にも管理できない。所有者がログインできない以上、変更操作にも到達できず、`release` も `disable` も通らない |
| `u18-nfc` だけ      | 紐づけが巻き戻り、**既に手放した（`release` した）カードが元の所有者のものとして復活する**。あるいは claim 前に戻り、紐づけコードが再び有効になる                                         |

**どちらも DB は正常に動き続ける。** 不整合を検出する制約が無いので、エラーも出ない。

> **両方を同じ時刻へ戻しても、ずれは完全には消えない**（§12.3）。片方だけ戻すよりは遥かにましというだけである。

復元後に不整合を洗い出す。**2 つの DB をまたぐ JOIN は書けない**ので、片方から ID を取り出してもう片方で照合する 2 段階になる。

```bash
# 1. NFC 側で、所有者が設定されているカードの owner_user_id を集める
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/nfc-worker
npx wrangler d1 execute u18-nfc --remote --json --command "
select distinct owner_user_id from nfc_cards where owner_user_id is not null;
" > /tmp/u18-nfc-owners.json

# 2. Identity 側で、その ID が実在し active かを確認する
#    （件数が多い場合は in (...) を分割する。付録 B 規則 5 と同じ考え方で、
#     まず count(*) を取ってから本体を流す）
cd /Users/tanahiro2010/Documents/proj/teams/under18dev/services/apps/auth-worker
npx wrangler d1 execute u18-identity --remote --command "
select id, status from users where id in ('<ID1>', '<ID2>', ...);
"
```

返ってこなかった ID が「存在しないユーザーを指しているカード」である。**自動で直す経路は無い。** 対応は 2 つしかない。

1. 該当カードを `status = 'disabled'`、`disabled_reason = 'ops'` にして止める（§11.2 ステップ 6 の SQL）。所有者を復帰させられる見込みが無い場合。
2. `owner_user_id = null`、`status = 'issued'`、`target_url = null`、`claim_code_hash = null` に戻して未紐づけへ差し戻す。**カードを回収できている場合に限る。** 回収していないのに `issued` へ戻すと、そのカードを持っている人間が claim できる状態になる。

**この照合を自動化する仕組みは無く、定期的に回す Cron も無い。** 復元を行ったときの手順として本節に書いてあるだけである。整合チェックの常設は残件とする（§12.6）。

### 12.5 Workers Secret は Time Travel の対象外

**Secret のバックアップ手段は存在しない。確認した事実として、`wrangler secret` のサブコマンドは `put` / `delete` / `list` / `bulk` の 4 つで、値を読み出す `get` に相当するものは無い**（`wrangler secret --help`、wrangler 4.152.0）。`wrangler secret list` が返すのは名前だけである。

したがって **Secret の正本は Cloudflare の中にしか無く、そこから取り出せない。** 手元に控えが無ければ、失われた時点で復元不能である。

| Secret            | 失うと何が起きるか                                                                                                                                                                                                                                                                               | 回復できるか                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `SIGNING_KEY_JWK` | ID Token に署名できなくなる。`SigningKeyProvider.getActiveSigningKey()` は `UseCaseResult` ではなく **throw する**ので、トークン発行経路が落ちる（§4 / `architecture.md` §4.1）。**既存のブラウザセッションは壊れない** —— セッション検証は `sessions.token_hash` だけを見ており署名鍵を使わない | **できる。** §4.2 の手順で新しい鍵へローテーションする。利用者の再ログインは不要。RP 側の JWKS キャッシュが切れるまで検証失敗が出る |
| `SIGNING_KEY_KID` | `SIGNING_KEY_JWK` と不一致になり、全 ID Token が RP 側で検証不能になる                                                                                                                                                                                                                           | **できる。** 上と同じ手順で揃え直す                                                                                                 |
| `IP_HASH_PEPPER`  | **過去の `ip_hash` と新しい `ip_hash` が永久に照合できなくなる。** 同じ IP からのアクセスかどうかが分からなくなり、§5.2 の侵害調査とセッション一覧 UI の継続性が失われる                                                                                                                         | **できない（過去分は）。** pepper を再現する手段が無く、hash から IP も戻せない                                                     |

**`IP_HASH_PEPPER` を失っても認証は止まらない。** 確認した事実として、`ipHash` はコード中で**書き込みにしか使われていない** —— `IssueSessionUseCase` が `sessions.ip_hash` を書き、`AuditLogger` が `audit_logs.ip_hash` を書くだけで、**照合・比較に使っている箇所は無い**（`apps/auth-worker/src` 全体を確認）。新しい pepper を設定すれば、以後のログインは正常に動く。失われるのは過去との連続性だけである。

**ただし新しい pepper を入れずに非 development 環境を運用すると、ログインが失敗する**（`UnconfiguredIpHasher`。§1.5 の注記のとおり、`/health` や Discovery は巻き添えにならない）。Secret を失ったことに気づくのは、たいていこの形である。

#### Secret の控えをどこに置くか

**未決である。** 控えを持てば「D1 ダンプと pepper が同じ場所に揃う」というリスクが生まれ（§6.3 の取り扱い規則 3）、持たなければ `IP_HASH_PEPPER` の喪失が不可逆になる。現時点で言えるのは次のとおり。

- **`SIGNING_KEY_JWK` / `SIGNING_KEY_KID` の控えは持たないほうがよい。** 失っても §4.2 でローテーションできるのに対し、控えの存在そのものが §5.1 の漏洩経路を 1 つ増やす。§1.4 の blast radius 表で**最大**とされている値である。
- **`IP_HASH_PEPPER` は控えを持つ価値がある。** 失うと過去分が不可逆に失われ、再生成では取り戻せない。保管場所は **D1 のエクスポートとは物理的に別**であること（揃うと IPv4 空間の総当たりで IP が復元できる。§1.4）。
- 控えを持つなら、**誰がアクセスできるかを Cloudflare アカウントのアクセス権と同じかそれ以下にする**こと。広げると、Cloudflare に入れない人間が本番の秘密を読める状態になる。

### 12.9 R2 の保持期間（仕様書 §14.1 決定 14）

**プレフィックスごとに別のルールを置いている。** 2026-10-25 に設定済み。

| プレフィックス | 期限               | 中身                                                            | 総到達年数                                     |
| -------------- | ------------------ | --------------------------------------------------------------- | ---------------------------------------------- |
| `audit_logs/`  | **730 日**（2 年） | D1 の保持区分を過ぎた監査ログ。`ip_hash` と `user_agent` を含む | `security` で **4 年**、`standard` で約 2.5 年 |
| `d1-backups/`  | **90 日**          | D1 の完全な複製。**全利用者の平文メールアドレス**を含む         | 90 日                                          |

「総到達年数」が期限より長いのは、**R2 へ来る行が D1 の保持区分を過ぎたもの**だからである。`security`（支配権が変わる操作）は D1 に 2 年居てから退避されるので、R2 の 2 年と合わせて 4 年まで遡れる。

```console
$ wrangler r2 bucket lifecycle list u18-identity-archive
name:     audit-logs-2y
prefix:   audit_logs/
action:   Expire objects after 730 days

name:     d1-backups-90d
prefix:   d1-backups/
action:   Expire objects after 90 days
```

#### ⚠️ ライフサイクルルールは遡って効く

**期間を決める前に「とりあえず」置かないこと。** 既存のオブジェクトごと消える。`audit_logs/` には **D1 から既に消えた行**が入っているので、消すと戻せない。

退避先を増やすとき、あるいは期限を**短く**するときは、**先に最古のオブジェクトの経過日数を調べ、何が消えるかを確認してから**適用すること。

```console
$ node scripts/backup-d1.mjs list --prefix ""
2026-10-24T23:00:41.377Z   255 バイト  audit_logs/...
```

設定時点で最古は 1 日だったため、どちらのルールでも削除は発生していない。

#### 期限を変えるとき

**D1 側の区分（`AuditRetention`）と対で見ること。** R2 側だけを短くすると D1 の区分が無意味になる。`audit_logs/` を `standard` の 180 日に合わせてはいけない理由がこれで、**合わせるなら `security` の 2 年のほう**である。

`d1-backups/` を延ばす判断は、**完全な複製を何本並べて持つか**の判断でもある。復旧に役立つ量を超えた分は露出を増やすだけになる。

### 12.6 公開前に済ませること

§6.4 のリハーサルチェックリストに加えて、**本節の内容について実施していない項目**を挙げる。すべて未了である。

- [ ] **Time Travel の復元を一度実行して検証する。** `u18-identity` と `u18-nfc` の**両方**で行う。本番 DB では行わない（§6.4 のリハーサル用 DB を使う）。少なくとも次を実測して §12.2 の「未確認」欄を埋める:
  - [ ] 復元の所要時間
  - [ ] 復元中にデータベースへ読み書きできるか
  - [ ] 復元の出力に含まれるブックマークで、復元を取り消せるか
  - [ ] 復元後に `d1_migrations` の内容が巻き戻っているか
- [ ] **2 つの D1 を同じ時刻へ復元したときのずれを実測する。** §12.3 で「保証は無い」と書いた点を、実際にどの程度ずれるかの数字に置き換える
- [ ] **§12.4 (2) の署名鍵の不整合を、リハーサル用 DB で一度再現する。** 鍵ローテーションより前へ巻き戻し、JWKS に kid が無くなることを確認する
- [ ] `u18-nfc` を §6.3 のエクスポート運用と §6.4 のリハーサルの対象に加える（**現在 §6 は `u18-identity` しか見ていない**）
- [ ] **凍結アカウントの保持期間を決める**（§11.6）。(a) 個人情報を落とす経路を作るか、(b) 表示を「無効化」に改めるか。仕様書 §14.2 未決定 2
- [ ] **メールアドレスへのアクセスを失った利用者の審査手順を決める**（§10.4 の 4 項目）。承認者の人数、本人確認の材料、記録の所在、待機期間
- [ ] **管理者を作るなら Passkey を 2 本以上登録させてから `scripts/admin-role.mjs grant` を使う**（§10.5）。1 本しか無い管理者はその 1 本を外せず、失うと 2 名承認の人手の復旧しか残らない
- [ ] 2 つの D1 の整合（`nfc_cards.owner_user_id` の宛先）を定期的に照合する仕組みを用意するか、照合しないことを受容するリスクとして記録する（§12.4 (5)）
- [x] ~~**R2 を U18 Developers アカウントで有効化する**~~ — 完了（§12.7）
- [x] ~~`wrangler r2 bucket create u18-identity-archive` でバケットを作る~~ — 完了（§12.7）
- [x] ~~**バケットが公開されていないことを確認する**~~ — 完了（2026-10-24、§12.7。2026-10-25 に再確認）。監査ログには `ip_hash` と `user_agent`、D1 ダンプには平文のメールアドレスが入る。**退避先を増やしたときは同じ 3 点を確認すること** —— `node scripts/check-bucket-visibility.mjs <bucket>` にまとめてある。**まだ定期実行には繋いでいない**（§12.7）
- [x] ~~**監査ログの退避が本番で動くことを確認する**~~ — 完了（§12.7、2026-10-24 に 1 往復）
- [x] ~~**D1 のバックアップから実際に復元を通す**~~ — 完了（2026-10-25、§12.8）。**通した結果、生のダンプは復元できないことが判明した**（#164）。`restore` が並べ替えたファイルを使うこと
- [x] ~~**R2 の保持期間（ライフサイクルルール）を決める**~~ — 完了（2026-10-25、§12.9 / 仕様書 §14.1 決定 14）。`audit_logs/` 730 日、`d1-backups/` 90 日
- [ ] `IP_HASH_PEPPER` の控えを持つかどうかを決める（§12.5）
- [ ] **`PRODUCTION_URL` を設定する前に署名鍵を揃える。** デプロイ後のスモークテストが `/health` の `checks.signingKey == "ok"` を要求する（§4.4）。`SIGNING_KEY_JWK` と `signing_key_metadata` の片方でも欠けているとデプロイジョブが赤くなる。順序は §2.4.1 → §9.5 → `pnpm key:verify`

### 12.7 R2 への退避（#43 の残件 / #27）

D1 の外へ出す経路は 2 つある。**目的が違うので片方で代用できない。**

| 経路                | 何を                   | いつ                              | 認証                        |
| ------------------- | ---------------------- | --------------------------------- | --------------------------- |
| `audit_logs` の退避 | 180 日を過ぎた監査ログ | Cron（15 分おき）の掃除の中で自動 | `r2_buckets` バインディング |
| D1 のバックアップ   | DB 全体のダンプ        | 手動 / 定期（未設定）             | wrangler または S3 認証情報 |

退避先はどちらも `u18-identity-archive` バケット。**公開しないこと** —— 監査ログには `ip_hash` と `user_agent` が、D1 ダンプには平文のメールアドレスが入っている。

#### 本番で往復を確認済み（2026-10-24）

R2 は有効化済み、バケット `u18-identity-archive` も作成済み。**退避の経路は本番で実際に 1 往復している。**

| 確認点            | 結果                                                             |
| ----------------- | ---------------------------------------------------------------- |
| R2 のオブジェクト | **1 件、353 B**                                                  |
| キー              | `audit_logs/2026/10/24/2026-10-24T23-00-41-045Z-da99ed02.ndjson` |
| 退避した Cron     | **23:00 の回**（行を入れたのは 22:51。次の 15 分刻みで拾われた） |
| D1 の該当行       | **消滅**（`count(*) = 0`）                                       |
| 中身              | NDJSON として parse 成功、1 行                                   |

検証は 1 年前の `created_at` を持つ合成行を 1 件入れて行った。**そのオブジェクトはバケットに残してある** —— 消すと `object_count` が 0 に戻り、次に見た人が同じ検証を一からやり直すことになるため。中身は `"reason": "archive_probe"` / `"metadata": {"synthetic": true}` で自己申告しており、**実データではない。**

> バケットを「空であるべき」と思って掃除しないこと。実データの退避が始まるのは、最初の行が保持期限（180 日）を過ぎてからである。

#### 復元のとき: NDJSON の型は D1 の列と一致しない

**退避したオブジェクトをそのまま D1 へ戻せない。** 実際に退避された行:

```json
{
  "id": "aud_...",
  "event": "otp.start",
  "userId": null,
  "actor": null,
  "outcome": "success",
  "reason": "archive_probe",
  "metadata": { "synthetic": true, "purpose": "verify #140" },
  "ipHash": null,
  "userAgent": null,
  "createdAt": "2025-10-24T22:51:46.215Z"
}
```

Drizzle が読んだ値をそのまま `JSON.stringify` しているので、**2 つの列で型が変わっている。**

| 列           | D1 の型                 | NDJSON での形              | 戻すときに要る変換        |
| ------------ | ----------------------- | -------------------------- | ------------------------- |
| `metadata`   | TEXT（JSON 文字列）     | **オブジェクト**として展開 | `JSON.stringify()` し直す |
| `created_at` | INTEGER（epoch ミリ秒） | **ISO 8601 文字列**        | `Date.parse()`            |

この形は**読むのに都合がよく、戻すのに一手間かかる**という取引である。`jq` でそのまま中身を見られることを優先した（§12.8 の「圧縮していない理由」と同じ判断）。

**戻す経路はまだ書いていない。** 必要になったとき——つまり 180 日より前の監査ログを調査で引くとき——に、上の 2 つの変換を入れたスクリプトを書く。読むだけなら `jq` で足りるので、**急いで書く理由は無い**（書いたまま一度も使われない復元スクリプトは、いざというとき動かない）。

#### 退避に失敗したら掃除が止まる

バケットが消えた・権限が落ちた等で退避に失敗すると、**`audit_logs` の掃除だけが止まる。** `PurgeExpiredRecordsUseCase` が `failed: ["audit_logs"]` を記録して次のテーブルへ進む。他の 4 テーブルは従来どおり消える。認証・`/health`・OIDC は影響を受けない。

**これは意図した挙動である。** 退避できないまま消すより、溜めて `retention sweep` のログに出し続けるほうがよい。素通しして削除を続ける実装にはしていない。溜まっていることは次で見る:

```bash
npx wrangler tail u18-auth-production --format pretty | grep retention
# {"deleted":…,"failed":["audit_logs"],…}
```

退避したキーも構造化ログに出る。消えた行がどのオブジェクトに入っているかは、これで辿る:

```bash
npx wrangler tail u18-auth-production --format pretty | grep "retention archive"
# {"target":"audit_logs","key":"audit_logs/2026/10/24/…","rowCount":1,"bytes":353,"deleted":1}
```

#### 公開していないことの確認（2026-10-24）

退避先には **`ip_hash` と `user_agent`** が入る。D1 のダンプ（§12.8）を同じバケットへ置くなら **平文のメールアドレス**も入る。バケットが読めると監査ログがそのまま読めるので、3 経路を塞いであることを確認した。

| 経路                | 確認に使ったコマンド                                  | 結果                                                    |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| `r2.dev` の公開 URL | `wrangler r2 bucket dev-url get u18-identity-archive` | `Public access via the r2.dev URL is disabled.`         |
| カスタムドメイン    | `wrangler r2 bucket domain list u18-identity-archive` | `There are no custom domains connected to this bucket.` |
| CORS                | `wrangler r2 bucket cors list u18-identity-archive`   | `The CORS configuration does not exist. [code: 10059]`  |

**CORS の確認はエラーとして返る。** `wrangler` は設定が無いことを `[code: 10059]` の ERROR で表現するので、終了コードだけを見るスクリプトに繋ぐと「確認に失敗した」と「公開していない」を取り違える。**この 10059 が安全側である。**

退避先を増やしたとき（別バケット、別アカウント）は同じ 3 点を確認すること。R2 は既定で非公開なので、**公開は必ず誰かの明示的な操作で起こる** —— つまり増やした時点より後に変わりうる。

**アカウントが複数ある環境では `CLOUDFLARE_ACCOUNT_ID` を先に設定すること。** 指定しないと非対話モードで選べず、3 つとも実行前に落ちる。

```
✘ [ERROR] More than one account available but unable to select one in non-interactive mode.
```

U18 Developers 以外のアカウントも同じログインから見えるので、**無指定で失敗したときに「権限が無い」と読み違えやすい。** 値は `CLOUDFLARE_ACCOUNT_ID`（GitHub Secret と同じもの）。

#### なぜ 3 つ全部を見るのか

**`r2.dev` だけ確認して「非公開」と判断しないこと。** カスタムドメインが繋がっていれば、r2.dev が無効でもオブジェクトは読める。経路が独立しているので、1 つ閉じていることは他の 2 つについて何も言わない。

CORS はそれ単体では公開にならない。それでも見るのは、**設定されていること自体が「ブラウザから読ませる意図があった」痕跡**だからである。意図があったなら、他の 2 経路も開いている可能性が高い。

#### この確認は一度では終わらない

**公開はダッシュボードからの操作で起こり、リポジトリ側に痕跡が残らない。** コードも設定ファイルも変わらないまま、バケットだけが公開になる。つまり `git log` を追っても分からず、**次に誰かが 3 コマンドを打つまで誰も気づかない。**

上の表の 3 コマンドは、`scripts/check-bucket-visibility.mjs` にまとめてある。

```bash
CLOUDFLARE_ACCOUNT_ID=… node scripts/check-bucket-visibility.mjs
# バケット: u18-identity-archive
#
#   [閉] r2.dev の公開 URL — r2.dev の公開 URL は無効
#   [閉] カスタムドメイン — 接続されたカスタムドメインは無し
#   [閉] CORS — CORS 設定なし（10059）
#
# 3 経路とも閉じている。
```

**3 経路とも閉じているときだけ 0 で終わる。** 1 つでも開いていれば、あるいは**確かめられなければ**、非ゼロで終わる。

```bash
node scripts/check-bucket-visibility.mjs u18-does-not-exist
#   [？] r2.dev の公開 URL — The specified bucket does not exist. [code: 10006]
#   …
# 確かめられなかった経路がある。**これは「公開していない」ではない。**
```

##### 終了コードを見ていない

**`wrangler` の終了コードは「公開しているか」を表していない。** `cors list` は設定が無いとき `10059` をそのまま投げて非ゼロで終わるので、**一番安全な状態が終了コードの上では失敗に見える**（上記）。判定は出力の内容で行い、終了コードは参考情報として detail に出すだけにしてある。

**CORS が「無い」形は 2 つある。** 一度も設定していないバケットは `10059` のエラー、設定してから空にしたバケットは `There is no CORS configuration defined for bucket '…'.` を出して 0 で終わる（`wrangler` の実装を読んで確認した）。上の表は前者しか記録していなかった。**どちらも「CORS は無い」**ので両方とも「閉」と判定する。

##### 「閉じている」は名指しでしか認めない

判定は 3 値（閉／開／？）で、**既知の「閉じている」印が出力にあるときだけ「閉」**とする。印が無ければ「？」であって、「閉」には倒さない。認証切れ、バケット名の間違い、`wrangler` の文面の変化は、すべて「？」に落ちる。

**「？」は「開」と同じく異常として扱う。** 原因は違うが、**どちらも『公開していないことを確認した』とは言えない**という点で同じである。

逆向き（印が無ければ閉じている扱い）にすると、`wrangler` が文面を変えた日から検査は何も見ずに緑を返し続ける。脅威モデル §4.4 の「宣言はあるが発動しない」である。

##### まだ CI には繋いでいない（残件）

**CI へ R2 の読み取り権限を渡すかが未決。** 検査のためだけに `deploy.yml` の認証情報の範囲を広げる判断になり、`.github/workflows/README.md` に書いたとおり**同じジョブ内の任意のステップがその認証情報を読める。**

繋ぐときは、**秘密が無いときに静かに skip する作りにしないこと。** それは「宣言はあるが発動しない」をもう 1 つ増やすだけである。秘密が無ければ落ちる形で繋ぐ。

#### 有効化の経緯（再発時の切り分け用）

有効化前は `wrangler r2 bucket list` が `Please enable R2 through the Cloudflare Dashboard. [code: 10042]` を返していた。**これは OAuth スコープ不足ではない** —— 同じログインで他のアカウントは成功し、10042 を返すのは当該アカウントだけだった。

`<accountid>.r2.cloudflarestorage.com` への TLS handshake failure も同じ原因である。**ローカルの TLS スタックの問題ではない**（`openssl s_client` は証明書を `Verify return code: 0 (ok)` で検証でき、同じ curl で `api.cloudflare.com` は応答する）。

> 余談として、apex の `r2.cloudflarestorage.com` は **2026-09-09 に期限切れになった証明書**を返す。アカウントのエンドポイントとは別物なので実害は無いが、ここを叩いて切り分けようとすると誤解する。

有効化はダッシュボードでの操作（課金の同意を含む）で、スクリプトからは行えない。

### 12.8 バックアップの取得と復元（#27）

```bash
node scripts/backup-d1.mjs self-check          # 署名の自己検査
node scripts/backup-d1.mjs export              # 2 つの D1 をローカルへ
node scripts/backup-d1.mjs run                 # export + R2 へアップロード
node scripts/backup-d1.mjs list
node scripts/backup-d1.mjs restore --key K
```

**既定は `--remote`。** バックアップにローカル DB を取っても意味が無いので、他のスクリプトと既定が逆になっている。

**2 つの DB を必ず揃えて取ること。** 既定の `--db all` がそうしている。片方だけ戻すと `nfc_cards.owner_user_id` が存在しないユーザーを指す（§12.4 (5)）。取得時刻は完全には揃わないので、`manifest.json` に両方の時刻を書き出している。

#### 検証できたこと / できていないこと

| 項目                                  | 状態                                                          |
| ------------------------------------- | ------------------------------------------------------------- |
| `wrangler d1 export` でダンプが取れる | **確認済み**（ローカル D1、8.9 KB）                           |
| ダンプに行が入っている                | **確認済み**（目印の行を入れて往復で確認）                    |
| SigV4 の鍵導出                        | **確認済み**（AWS 公開ベクタ 2 本と一致。`self-check`）       |
| 正規化リクエストの組み立て            | **確認済み**（2026-10-25。`list` が実サービスから一覧を取得） |
| R2 へのアップロード / 取得            | **確認済み**（2026-10-25。2 つの DB を往復）                  |
| ダンプからの復元                      | **確認済み**（2026-10-25。ただし並べ替えが要る。下記）        |

#### 復元についてわかったこと —— 既存の DB には流せない

**`wrangler d1 export` の出力は、中身の入った DB にそのままは流せない。** 実際に試すと最初の `INSERT` で止まる:

```
✘ [ERROR] UNIQUE constraint failed: d1_migrations.id: SQLITE_CONSTRAINT
```

ダンプは `CREATE TABLE IF NOT EXISTS` と素の `INSERT INTO` の列で、**`d1_migrations` の行まで含む**。つまり既存の行とぶつかる。「上書きで戻す」という操作は存在しない。

**したがって復元先は空の DB でなければならない。** 現実的な手順は、

1. `wrangler d1 create u18-identity-restored` で**新しい DB を作る**
2. ダンプをそこへ流す
3. 中身を確認してから、`wrangler.jsonc` の `database_id` を差し替えてデプロイする

テーブルを消して同じ DB へ入れ直す手は**勧めない**。外部キーの依存順に引きずられて `DROP TABLE` が途中で `no such table` で落ちる（実際に落ちた）うえ、失敗した時点で本番 DB が半壊する。

> `PRAGMA defer_foreign_keys=TRUE` では足りない。コミットまで遅延するだけで、`DROP` の最中の参照解決には効かない。

#### 生のダンプは並べ替えないと流せない（#164）

**`wrangler d1 export` の出力は、空の DB に対しても失敗する。**

```
✘ [ERROR] no such table: main.users: SQLITE_ERROR
```

ダンプは**テーブルごとに `CREATE TABLE` と `INSERT` を交互に**並べ、テーブルの順序はアルファベット順である。つまり `user_emails` の `INSERT` が `CREATE TABLE users` より先に来る。親が存在しない時点で子へ入れることになる。

先頭の `PRAGMA defer_foreign_keys=TRUE` は効かない。**wrangler がファイルを文に分割してバッチで送るため、PRAGMA が後続の文に持続しない。**

**子テーブルに行が無い間は通ってしまう。** 問題の `INSERT` 自体が生成されないためで、本番で最初のアカウントができた時点（2026-10-24）から壊れた。**取得したダンプを一度も流さずに運用すると、必要になった日に初めて壊れていると分かる。**

`node scripts/backup-d1.mjs restore --key K` が `*.restorable.sql` を並べて出すので、**流すのはそちら**。生のダンプも残るので、Cloudflare の出力そのものと見分けられる。並べ替えは次の順序になる。

1. `PRAGMA`
2. 全 `CREATE TABLE`（**外部キーの親から子へトポロジカルソート**）
3. 全 `INSERT`（同じ順序）
4. `sqlite_sequence` への操作 —— AUTOINCREMENT を持つテーブルが作られて初めて暗黙に生成されるので、先頭に置くと `no such table: sqlite_sequence` で落ちる
5. 全 `CREATE INDEX`

#### 本番で通した記録（2026-10-25）

使い捨ての D1 を作って往復し、確認後に削除した。

| 確認                             | identity             | nfc                |
| -------------------------------- | -------------------- | ------------------ |
| 取り込み                         | 14 テーブル / 572 行 | 3 テーブル / 20 行 |
| `PRAGMA foreign_key_check`       | 違反ゼロ             | 違反ゼロ           |
| `sqlite_master` のオブジェクト数 | 本番 46 / 復元 46    | ——                 |

`audit_logs` だけ本番 98 / 復元 92 と差が出たが、これはバックアップ取得後に本番が増えた分（`retention.sweep` が 15 分おきに 1 行）で、**時点のバックアップとして正しい**。

#### 定期実行（services-d5 へ渡す分）

`.github/workflows/` への組み込みは未実装。必要なものは次のとおり。

- **`CLOUDFLARE_API_TOKEN`**（既存。デプロイで使っているもの）に **D1 の読み取り**と **R2 の書き込み**権限があること。既存トークンの権限は未確認
- `--s3` で動かす場合は `S3_ENDPOINT` / `ACCESS_KEY` / `SECRET_KEY` を GitHub Secrets へ置く。**ただし既定の wrangler 経路なら新しい Secret は要らない**（§12.5 の「保管場所を増やさない」方針）
- 実行頻度は**未決**（§8.5 未決事項 1）。**R2 側の保持期間は決定済み**（仕様書 §14.1 決定 14、下記 12.9）
- ランナーに落ちたダンプを消すこと。平文のメールアドレスが入っている

---

### 12.10 CodeQL の `js/file-access-to-http` が 5 件開いたままである

`scripts/backup-d1.mjs` に対する **`js/file-access-to-http`（medium 5 件）を、直さず開いたままにしている。**

> Outbound network request depends on file data.

**指摘は正しく、しかも意図した動作である。** D1 のダンプを読んで R2 へ送るのがこのスクリプトの目的そのもので、**ファイルの中身が外へ出ないようにすると機能が無くなる。**

#### 「意図どおり」だけでは片付けなかった

ルールが言う _unauthorized information disclosure_ には、この形でしか起きないリスクが実際にあった —— **送り先を無条件に信じていた。** `.env` の `S3_ENDPOINT` が書き換わる、あるいは**単に打ち間違える**と、平文のメールアドレスを含む Identity DB の完全な複製が別の宛先へ届く。

2 段で塞いである。どちらも `scripts/lib/s3-endpoint.mjs`。

| 検査                                                         | 何を保証するか             |
| ------------------------------------------------------------ | -------------------------- |
| `https` であること（#183）                                   | 経路上で**盗み見られない** |
| `hostname` が `.r2.cloudflarestorage.com` であること（#199） | **正しい相手へ送っている** |

**前者だけでは足りない。** https は「盗み見られない」を保証するだけで、宛先が正しいことは何も保証しない。

後者を**生の文字列の後方一致にしていない**のも重要で、fragment もクエリも末尾に付けられるため `endsWith()` は宛先の判定にならない:

```js
"https://evil.example/#.r2.cloudflarestorage.com".endsWith(SUFFIX); // true
"https://evil.example/?x=.r2.cloudflarestorage.com".endsWith(SUFFIX); // true
```

パーサを通した `hostname` を見る。

#### なぜ dismiss していないか

**dismiss の API（`PATCH /code-scanning/alerts/N`）が権限分類器に拒否された。** 迂回していない。Security タブから手で落とすか、開いたままにするかは運用の判断で、**どちらでもこの節が理由になる。**

開いたままにする場合の読み方: **この 5 件は「送り先の検査が無い」ことを指しているのではなく、「ファイルの中身が外へ出る」ことを指している。** 後者は仕様なので消えない。**件数が 5 から増えたら新しい経路が足されたということ**なので、そのときは調べること。

## 13. レート制限（#21）

### 13.1 三層で 1 組である

レート制限は**バースト**・**持続**・**総量**の 3 層に分かれている。どれか 1 つでは濫用を止められない。

| 層       | 守るもの             | 鍵             | 実装                             | 窓     |
| -------- | -------------------- | -------------- | -------------------------------- | ------ |
| バースト | 短時間の大量アクセス | IP（ハッシュ） | Cloudflare Rate Limiting binding | 60 秒  |
| 持続     | 長時間かけた濫用     | メールアドレス | D1（`email_challenges` の行数）  | 1 時間 |
| 総量     | 送信経路そのもの     | **用途のみ**   | D1（`email_challenges` の行数）  | 1 時間 |

**3 つ目は後から足した**（#236）。最初の 2 つは IP かアドレスのどちらかに鍵を持っていて、**宛先を変えながら送る攻撃が両方を同時に外す**ことが分かったため。下の「2 つの穴は直交していない」を読むこと。

**Cloudflare の binding は `period` に 10 秒か 60 秒しか取れない。** つまりバースト層で止められるのは「1 分に大量」までで、「60 秒ごとに 1 通を延々と」は素通りする。これは #88 で実際に起きていた穴（再送上限が一度も発動せず、60 秒ごとに無制限にメールを送れた）と同じ形なので、持続層を別に持っている。

逆に持続層はアドレス単位なので、**宛先を変えながらの攻撃には効かない**。そちらはバースト層が受け持つ —— **ことになっているが、本番では受け持ち切れていない。** 次項を読むこと。

> **「レート制限は入っている」と片方だけ見て判断しないこと。** どちらが欠けても、残ったほうをすり抜ける攻撃が成立する。

#### 2 つの穴は直交していない（#236）

表を素直に読むと「片方の穴をもう片方が塞ぐ」ように見える。**実際には 1 つの攻撃手順が両方を同時に外す。**

| 層       | 外れ方                                                               |
| -------- | -------------------------------------------------------------------- |
| バースト | **近似なので設定の数倍通る**（§13.2）。IP を分ければもともと効かない |
| 持続     | アドレス単位なので、**宛先を変えれば効かない**                       |

宛先を変えながら送る攻撃は、持続層を素通りし、バースト層も設定どおりには止めない。**signup は未登録のアドレスへ送る**（`shouldSend` が `purpose === "signup" ? user === null : ...`）ので、これはメール爆撃にそのまま使える。

**二層あることは正しい。「二層あるから止まる」が正しくない。** どちらも IP かアドレスのどちらかに鍵を持っており、**その両方に依らない層が無かった**。

#### 総量の層（#236 で足した）

`OtpPolicy.globalMaxSends` が**用途ごと**の上限を持つ。鍵は用途だけで、**IP にもアドレスにも依らない**。攻撃者が IP を増やしても宛先を変えても回避できない。

| 用途           | 窓あたり |
| -------------- | -------- |
| `login`        | 200      |
| `signup`       | 30       |
| `verify_email` | 50       |
| `recovery`     | 50       |

**用途ごとに分けてあるのは、ログインを守るため。** ログインが死ぬと既存の利用者が全員締め出されるので、攻撃者にとってはそちらのほうが安い目標になる。signup が尽きるのは「新規登録が一時的に止まる」で、被害の質がまるで違う。

**この層は攻撃者に「新規登録を 1 時間止める」手段を与える。** 1 時間に 30 通ぶん撃てばよい。それでも入れたのは、**送信レピュテーションを失うほうが重い**から —— 大量送信で弾かれるようになると、新規登録だけでなく**既存利用者のログインコードも届かなくなる。**

**窓を 1 時間より長くできない。** 持続層とまったく同じ制約で、数える材料が `email_challenges` の行である以上、掃除された行は数えられない（§7 の保持期間）。`test/otp-global-cap.test.ts` の不変条件がこれを止める。

**数えるのは「送信を試みた回数」**で、届いた回数ではない。行は送信の `await` より前に作られるので、プロバイダが落ちている間も数が進む。総量の上限としてはそのほうが安全側である（叩き続けない）。

**枠を消費するのは行を作ったときだけ。** 送らないと決まった要求（登録済みアドレスへの signup など）は何回叩いても枠に入らない。この性質は判定の位置ではなく**数え方**から来ているので、「要求数を数える」実装に変えると消える。

上限に達したことは監査に出る（`otp.start` / `outcome: failure` / `reason: global_send_cap`）。**止まったことに誰も気づかない状態にはしない** —— 応答は正常系と同じなので、利用者にも攻撃者にも区別がつかず、ここでしか分からない。

### 13.2 閾値と、その根拠

いずれも IP 単位・60 秒窓。出典は `apps/auth-worker/src/domain/services/rate-limit-policy.ts`。

| binding              | 対象                                          | 上限 | 根拠                                                                                                                       |
| -------------------- | --------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| `RL_EMAIL_START`     | `POST /api/auth/email/start`                  | 10   | 1 通送るのに 1 回。利用者側には 60 秒の再送クールダウンがあるので、正常利用で 1 分に 10 回へ届かない                       |
| `RL_EMAIL_VERIFY`    | `POST /api/auth/email/verify`                 | 15   | challenge 単位の試行上限（5 回）はアドレスを変えると効かないので、IP 側で頭を押さえる。打ち間違いの入力は 1 分に数回が上限 |
| `RL_LOGIN_VERIFY`    | `POST /api/auth/passkeys/login/verify`        | 20   | 署名検証は CPU を使うため、失敗を投げ続けられること自体が負荷。正常利用は 1 回で終わる                                     |
| `RL_OAUTH_AUTHORIZE` | `GET /oauth/authorize`、`POST /oauth/consent` | 30   | ブラウザ経路。正常利用は 1 往復につき authorize 1 回 + consent 1 回。SSO で複数アプリを渡り歩いても届かない                |

**共有回線（学校・CGNAT）を想定して、「1 人分の必要回数」ではなく「同一 IP の後ろに何人いるか」で決めてある。** 1 人なら数回で済む操作に 10〜20 の枠を取っているのはそのため。弾かれた利用者からの報告が続くようなら、まずこの前提を疑うこと。

`RL_OAUTH_CLIENT` だけ**鍵が IP 単体ではない**ので別表にする。

| binding           | 対象                                      | 鍵                     | 上限 / 60 秒 |
| ----------------- | ----------------------------------------- | ---------------------- | ------------ |
| `RL_OAUTH_CLIENT` | `POST /oauth/token`、`POST /oauth/revoke` | `<client_id>:<ipHash>` | 60           |

#### なぜ `/oauth/token` だけ鍵が違うのか

#21 の本文は「client 単位」としていたが、**そのままでは攻撃者が被害クライアントを締め出せる。** `client_id` は秘密ではないので、他人のそれを名乗って枠を使い切るだけでよい。ブルートフォース対策のつもりが、より安いサービス妨害を 1 つ増やすことになる。

かといって IP 単体にもできない。**この 2 つを叩くのはブラウザではなく RP のサーバ**で、1 台に利用者全員分のトークン交換が集中する。

鍵を `<client_id>:<ipHash>` にすると両方が成り立つ:

- 本物の RP は**自分の IP に自分の枠**を持つ（攻撃者に消費されない）
- 攻撃者は「自分の IP × 被害クライアント」の枠しか消費できない

**残る穴**: 攻撃者が `client_id` を変えながら同じ IP から叩くと鍵が毎回変わるので、総量は抑えられない。ただしその経路はクライアント認証で即座に弾かれ、`client_id` の総当たりそのものになる。経路全体の総量規制は RR-1 の残りとして `/api/me` 系と一緒に扱う。

**`/oauth/revoke` が `/oauth/token` と枠を共有する**のは、RFC 7009 §2.1 が同じクライアント認証を求めており実装も共有しているため。攻撃者がどちらを叩いても同じ予算を消費するほうが総量として素直である。代償として、トークン交換の多い RP は失効の枠も食う。

**制限はクライアント認証より前に置く。** 後にすると、総当たりの 1 回ごとに秘密の照合（定時間比較つき）を走らせることになる。

#### 固定窓なので、境界を狙えば短時間に 2 倍送れる

Cloudflare の Rate Limiting は**壁時計に揃った固定窓**である。`epoch = floor(now / period)` で数え、**全キーが同じ瞬間に一斉にリセットされる**（miniflare の実装で確認。Cloudflare 側も固定窓と文書化されている）。

つまり窓の終わり際に上限まで送り、境界を越えた直後にもう一度上限まで送れば、**実質 1 秒程度で `2 × limit` 通る**。`RL_EMAIL_START` なら 20 通が一瞬で出る。

**これは設定では消せない。** スライディングウィンドウを持つ実装へ替えるか、持続側（アドレス単位・1 時間窓・D1 の行数）で受けるかのどちらかで、**後者は既に入っている**（`OtpPolicy.resendWindowMs`）。宛先を変えながらの攻撃には効かないが、同一アドレスへの連続送信はそちらで止まる。

閾値を決めるときは「1 窓あたり N」ではなく「**短時間に最大 2N**」で見積もること —— と書いていたが、**これでも足りない。** 次項。

#### そもそも上限は近似であって、設定の数倍通る（#236）

Cloudflare の Rate Limiting API は**厳密な上限ではない**。ドキュメントにそう書いてある。

> The Rate Limiting API provides an approximate limit.
> Rate limits are approximate and apply separately in each Cloudflare location.
> These counts do not combine into one worldwide limit.
> Counts are eventually consistent: each check uses a local count.
> If you need one strict limit across all locations, implement a rate limiter with Durable Objects.

つまり **(a) コロごとに別の上限**で、**(b) カウントは非同期に伝わる**。

本番の `/signup/start` で測った（形式不正の宛先なので送信ゼロ・D1 への書き込みゼロ。`RL_EMAIL_START` は `limit: 10 / period: 60`）:

```
窓が明けた直後から逐次 40 本（4 秒）   通った 36 / 止まった  4
  ................................X..X.XX.

直後にもう 40 本                       通った  9 / 止まった 31
  XX..XXXX....XXX..X.XXXXXXXXXXXXXXXXXXXXX

同一 60 秒窓の累計: 45 本が通った（設定は 10）
```

**形がはっきり出ている。** 最初の 32 本は素通りし、そのあとカウンタが追い付いて完全に止まる。**バーストは設定の 3〜4 倍抜け、持続攻撃はいずれ止まる。**

境界を狙う話（前項）は「2 倍」だったが、こちらは **1 コロで 4.5 倍**、コロを分ければ掛け算になる。**効くのはこちらのほうである。**

> **閾値の数字を「ここまでしか通らない」と読まないこと。** 読めるのは「これを大きく超えて続けることはできない」までである。桁で考えること。

**厳密な上限が要るなら binding では足りない**（Durable Object が要る）。**#236 で「要らない」と決めた。** 厳密にしても IP を分けられたら終わりで、4.5 倍を 1 倍にしても攻撃者のコストは 4.5 分の 1 になるだけ、**桁が変わらない**ため。代わりに「IP にもアドレスにも依らない層」を足している（§13.1 の総量）。

**覆す条件**: 総量の層を入れてなお、閾値に届く前に困ることが起きたら、そのときはバースト層の精度が効くようになっている。

> **決める期限: 2026-11-30。** 条件（「必要になったら」「余裕ができたら」）は誰も監視しないが、**日付なら機械が監視できる。** この日までに #236 に結論（やる／要らないと判断した理由）が書かれていなければ、**この段落が未決のまま残っていること自体を問題として扱う。**

測定は 1 台・1 回線から。**数字そのものは測る場所で変わる**（コロ単位なので）。再測して違う値が出ても、それは矛盾ではない。

#### 制限をどこに置くか —— 2 つの経路で順序が逆である

| 経路                         | 制限の位置               |
| ---------------------------- | ------------------------ |
| `/oauth/token`               | クライアント認証の**前** |
| form（`/signup/start` ほか） | CSRF 判定の**後**        |

逆に見えるが**矛盾ではない。1 つの原則で説明できる。**

> **制限は「高価な処理」の前に、かつ「攻撃者の要求と被害者の要求を見分ける検査」の後ろに置く。**

`/oauth/token` で守りたい資源は**照合そのもの**（定時間比較の計算）である。後ろに置くと、総当たりの 1 回ごとに比較が走る。そして**「他人の枠」という概念が無い** —— 鍵が `<client_id>:<ipHash>` なので、攻撃者は自分の枠しか消費できない。だから前に置く。

form で守りたい資源は**メール送信**で、CSRF 判定は安い。そして決定的なのは、**CSRF に落ちる要求は被害者のブラウザから出る**ことである —— クロスサイトから撃たれた form 送信は被害者の IP で届く。前に置くと、**攻撃者はトークンの無い要求を撃つだけで被害者を締め出せる。**

この順序は `test/rate-limit-form.test.ts` の「CSRF に落ちる要求は枠を消費しない」が固定している（#237）。**`freshIp()` を使うこと。** 以前は `signup.ui.test.ts` が `CF-Connecting-IP` を設定せず全テストが既定の IP を共有していたため、順序を逆にすると枠を食い尽くして落ちていた —— **固定できていたのは偶然で、IP を分けた瞬間に消える。**

#### テストを書くときの注意

OAuth 経路のテストは **`CF-Connecting-IP` を必ず付けること。** 付けないと全テストが `"unknown-ip"` の 1 つの枠を共有し、**テストを足しただけで無関係なテストが 429 で落ちる**（実際に起きた）。`test/helpers.oauth.ts` の `freshClientIp()` が呼び出しごとに別の IP を配る。

**窓の境界も避けること。** 「上限まで送ってから 1 本余計に送る」形のテストは、途中で窓が切り替わるとカウンタが戻って最後の 1 本が通る。`test/rate-limit.test.ts` の `beforeEach` が窓の頭まで待つので、同じファイルに足す分には何もしなくてよい。**別のファイルで同じ形を書くときは同じ手当てが要る**（#176）。

**テストの数字は miniflare に対するものである。** `test/rate-limit.test.ts` と `test/rate-limit-form.test.ts` は「上限までは通り、超えると 429」を主張できているが、それは **miniflare が厳密に実装しているから**であって、本番にその性質は無い（前項）。回帰は拾えるので価値はある。**あの数字を本番の保証として読まないこと。**

**まだ適用していないエンドポイント**: `/api/me` 系の読み取り API（RR-1 の残り）。

### 13.3 閾値を変えるときは 2 箇所を直す

`limit` と `period` の実体は `wrangler.jsonc` の `ratelimits` にあり、**コードからは読めない**。一方で 429 に載せる `Retry-After` の秒数はコード側（`RateLimitPolicy`）から出る。片方だけ変えると「60 秒待て」と言いながら実際の窓は 10 秒、という食い違いになる。

1. `apps/auth-worker/wrangler.jsonc` の `ratelimits`（**既定の env と `env.production` の両方**）
2. `apps/auth-worker/src/domain/services/rate-limit-policy.ts` の `RateLimitPolicy`
3. この節の表

`apps/auth-worker/test/rate-limit-config.test.ts` が 1 と 2 を照合するので、片方だけ直すと CI で落ちる。

### 13.4 本番だけ無防備になる経路

**`ratelimits` は named environment へ継承されない**（wrangler のスキーマに明記がある。`triggers` と同じ罠）。`env.production` に書き忘れると:

- 本番にだけ binding が無い
- binding が無い scope を使うと `CloudflareRateLimiter` が throw する → **429 ではなく 500**
- `/health` はレート制限を通らないので、#66 のデプロイ後スモークテストは**緑のまま**

この組み合わせが一番危ない。設定漏れが「ログインだけ 500」という形で出て、スモークテストでは検知できない。`rate-limit-config.test.ts` が `env.production` 側も照合しているのはこのため。

デプロイ後に疑うときは、本番へ 1 回だけ OTP 送信要求を投げて 500 が返らないことを見る。

### 13.5 超過したときに何が起きるか

- HTTP `429`、本文は `{ "error": "rate_limited", "message": "too many requests" }`
- `Retry-After` ヘッダに**窓の長さそのもの**（残り時間ではない）。binding は窓がいつ空くかを返さないので、短く見積もってまだ閉じた窓を叩かせるより窓全体を返す
- Workers のログ（observability）に `{"event":"rate_limit.exceeded","scope":...,"ipHash":...}` が 1 行出る。**生 IP は出ない**

  **`audit_logs` には書いていない。** 弾いたリクエスト 1 本ごとに D1 へ 1 行書くと、攻撃者は「弾かれること」をそのまま D1 への書き込みに変換できてしまう。レート制限が防ぐはずの資源枯渇（脅威モデル D-2）を、レート制限自身が引き起こすことになる。保持は `audit_logs` の 180 日より短いが、レート制限の超過は「今まさに起きている」ことを見るための情報で、半年後に遡る種類のものではない。追跡するときは `ipHash` で Workers のログを引く

- 判定は**本文を読む前**に行う。アドレスを見ていないので、429 の出方から「そのアドレスが登録済みか」は分からない（仕様書 9 Privacy）

`CF-Connecting-IP` が無いリクエストは**素通しせず**、全員で 1 つの枠を共有する。本番で Cloudflare がこのヘッダを付けない状況は通常ありえないが、万一そうなった場合は「全体が詰まる」という目に見える形で壊れる。静かに無防備になるよりよい。

### 13.6 namespace_id

`namespace_id` はアカウント内で一意なら任意の値でよく、D1 のような事前の払い出しは要らない。**ただし使い回すと別のエンドポイントとカウンタを共有する** —— OTP 送信の枠を Passkey のログインが食う、という形になる。重複は `rate-limit-config.test.ts` が検出する。

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
