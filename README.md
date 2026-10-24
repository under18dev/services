# u18 Identity

u18 の複数の Web サービスで共通利用する OpenID Connect Identity Provider。
Cloudflare Workers 上で動作し、認証情報の正本は Cloudflare D1（Drizzle ORM）に置く。
pnpm workspaces の monorepo で、`auth-worker`（OIDC と認証 API、Identity D1 の所有者）と
`dashboard-worker`（アカウント設定 UI / BFF）の 2 つの Worker を Service Bindings の RPC で
つないでいる。各 Worker の内部は Presentation / Application / Domain / Infrastructure に
分かれ、依存方向は ESLint で強制される。仕様書 12 の Phase 1 は完了し、Phase 2 は
**OIDC の Authorization Code Flow + PKCE が端から端まで通る**ところまで入っている
（ログイン手段は Passkey とメール OTP の 2 つ）。未実装は `/oauth/userinfo` と
`/oauth/revoke` の 2 本（詳細は [docs/architecture.md](./docs/architecture.md) §6）。

---

## 必要環境

| 項目       | バージョン                                   |
| ---------- | -------------------------------------------- |
| Node.js    | >= 22（`package.json` の `engines`）         |
| pnpm       | 12.15.0（`packageManager` で固定）           |
| Cloudflare | Workers Paid プラン（D1 / Service Bindings） |

pnpm は Corepack を使うのが確実。

```bash
corepack enable
corepack prepare pnpm@12.15.0 --activate
```

---

## 固定しているバージョンとその理由

`pnpm-workspace.yaml` で `strictPeerDependencies: false` にしているため
（pnpm 12 では `.npmrc` ではなくこちらに書く）、**peer の不一致があっても
`pnpm install` は警告だけで通る**。壊れるのはインストール時ではなく、
lint やテストを走らせたときになる。以下は安易に上げないこと。

### TypeScript 5.9.3

`typescript-eslint@8.72.0` の peer が `typescript: ">=4.8.4 <6.1.0"`。
TypeScript 6.1 以降（TypeScript 7 を含む）へ上げると、型情報を使う lint ルールが
パーサ側の API 変更で動かなくなり、`pnpm lint` が壊れる。
`pnpm typecheck` だけは通ってしまうことがあるため気付きにくい。

上げる場合は TypeScript 単独ではなく、`typescript-eslint` の peer 範囲が
その TypeScript を含むバージョンへ上がってから、両方を同時に上げる。
なお TypeScript は各 workspace の `devDependencies` にも `5.9.3` で入っているので、
ルートだけ書き換えても揃わない。

### vitest 4.1.12 と `@cloudflare/vitest-plugin`

テストは `@cloudflare/vitest-plugin@1.4.7` が用意する Workers ランタイム上で走る。

**`@cloudflare/vitest-pool-workers` からの改称先である**（#108）。旧パッケージは
0.23.0 が最後で、npm 上で deprecated —— 「`@cloudflare/vitest-plugin` へ改称、
今後更新しない」。上げる選択肢が無いので移行した。

`defineWorkersConfig()` は廃止されており、通常の `defineConfig()` に
`plugins: [cloudflareTest({...})]` を渡す。古い記事や以前のこのリポジトリの
コードを参考にして `defineWorkersConfig` へ戻さないこと。

peer は `vitest: "^4.1.0 || ^5.0.0"`。vitest 5 へ上げる余地はあるが、
**移行時は 4.1.12 のまま据え置いた** —— 一度に 2 つ動かすと、落ちたときに
どちらが原因か分からなくなる。

### `compatibility_date` = `2026-10-24`

`apps/*/wrangler.jsonc` の `compatibility_date` は **3 つの Worker で同じ値**に
する。仕様書の日付（`2026-10-24`）に揃えてある（#108）。ずれると
「dev では動くが別の Worker では挙動が違う」が起きる。

**今日の日付を自動で入れてはいけない。** これはバージョン固定と同じ性質の
制約なので、ここに書いておく。

テストが使う workerd が知らない `compatibility_date` を指定すると、
テストが 1 件も実行されずに起動時点で `ERR_FUTURE_COMPATIBILITY_DATE` で落ちる。
`wrangler dev` と `wrangler deploy` は新しい日付でも通ってしまうため、
「ローカルの dev は動くのに `pnpm test` だけ全滅する」という形で現れる。

**上限は workerd のビルド日ではない。** 以前ここには「ビルド日より後の日付で
落ちる」と書いてあったが、実測すると違う。現在の workerd
`1.20261019.1`（2026-10-19 ビルド）は:

| `compatibility_date` | 結果                            |
| -------------------- | ------------------------------- |
| `2026-10-19`         | **通る**（ビルド日ちょうど）    |
| `2026-10-24`         | **通る**（ビルド日の 5 日後）   |
| `2026-10-25`         | `ERR_FUTURE_COMPATIBILITY_DATE` |
| `2026-11-01` 以降    | `ERR_FUTURE_COMPATIBILITY_DATE` |

つまりビルド日より少し先まで受け付ける。**どこまで通るかは実際に
`pnpm test` を走らせて確かめるしかない。** いま入っている `2026-10-24` は
この実測で決めた値である。さらに進めるときは `@cloudflare/vitest-plugin` を
先に上げてから試すこと。3 つの Worker すべての `wrangler.jsonc` に
同じ趣旨のコメントを置いてある。

この境界がどこから来るのかは未確認である。workerd にコンパイル時に
埋め込まれた上限なのか、ビルド日からの固定オフセット（5 日）なのかを
区別するには別バージョンの workerd で測る必要があり、やっていない。
**「ビルド日 + 5 日」と覚えないこと。** 測り方だけを覚えること。

#### いまの値は上限ちょうどで、余裕がゼロである

`2026-10-24` は仕様書の日付であると同時に、**現在の workerd が受け付ける
上限そのもの**である（`2026-10-25` は落ちる）。日付を選んだ結果としては
正しいが、**余白が無い状態**でもある。

`@cloudflare/vitest-plugin` が将来より古い workerd を抱えるバージョンに
変わると、**こちらが何も変えていないのにテストが全滅する。** しかも
`wrangler dev` と `wrangler deploy` は通り続けるので、バンプと無関係な
破損に見える。

これを防いでいるのは、Dependabot の `cloudflare-workers-runtime` グループ
（#24）がこの一式を必ずまとめて動かすことである。**グループから外れた
単独バンプが作られるようになったら、この前提は崩れる。**

### テストと deploy が同じ workerd で動くようになった（#108）

**以前は lockfile に wrangler・miniflare・workerd がそれぞれ 2 つずつ
入っていた。** テストは 2026-08-15 ビルドの workerd、`wrangler dev` と
`wrangler deploy` は 2026-10-19 ビルドの workerd という状態で、
`compatibility_date` を縛っていたのは古いほうだった。

`@cloudflare/vitest-plugin@1.4.7` は **apps と同じ `wrangler@4.152.0` を
抱えている**ので、移行で二重化が消えた。

```
移行前                          移行後
workerd   1.20260815.1 / 1.20261019.1   →  1.20261019.1 のみ
miniflare 5.20260815.0-alpha / …-beta   →  5.20261019.2-beta のみ
wrangler  4.124.0 / 4.152.0             →  4.152.0 のみ
```

**テストと deploy が同じランタイムで動く。** 「テストは通るのに本番だけ
挙動が違う」の原因が 1 つ減った。

ただし**消えていないものもある**（期待しないこと）:

- **miniflare は依然 prerelease**（beta）。alpha と beta の 2 つが beta 1 本に
  なっただけで、安定版ではない。予告なく挙動が変わりうる。
- **`pnpm audit` の dev-only な指摘は残る。** 移行で **6 件 → 2 件**にはなった
  （`sharp` は旧 pool-workers 配下にしか無かったので消えた）が、`zod`
  （`vitest-plugin@1.4.7` が `4.6.5` を固定、修正版は `>=4.6.6`）と `undici`
  （miniflare 配下。wrangler 側からも入るので移行とは無関係）は残る。
  `ci.yml` が `--prod` を blocking、dev を informational に分けている理由は
  変わらない。

### その他

- `@cloudflare/workers-types` は `pnpm-workspace.yaml` の
  `minimumReleaseAgeExclude` に入れてある。Cloudflare のランタイム型は
  `compatibility_date` に追従して頻繁に出るため、公開直後でも取得できるようにする意図。
  ただし **`minimumReleaseAge` 本体がまだ設定されていないので、現状この除外は
  何も除外していない**（#101）。意図と実態がずれている状態で、
  `minimumReleaseAge` を有効にするのは依存ツリーが成熟してから。
- `allowBuilds` は `esbuild` と `workerd` のみ。ネイティブバイナリの取得に
  postinstall が必要なのはこの 2 つだけで、それ以外のビルドスクリプトは実行しない。
- `packages/config/tsconfig.lib.json`（Worker ではないパッケージ用）は
  `"types": ["@cloudflare/workers-types"]` を指定する。このリポジトリの
  パッケージはすべて最終的に workerd 上で動くので、`crypto.subtle` などの
  ランタイム標準グローバルを型として認識させる必要がある。代わりに DOM lib や
  `@types/node` を足してはいけない。`window` / `document` / Node のグローバルまで
  Domain 層から見えてしまい、workerd では動かないコードが型検査を通ってしまう。

---

## セットアップ

```bash
# 1. 依存をインストール
pnpm install

# 2. ローカル用のシークレットを用意
cp apps/auth-worker/.dev.vars.example apps/auth-worker/.dev.vars
#    少なくとも IP_HASH_PEPPER を環境固有の値に変える。
#    .dev.vars は .gitignore 済み。コミットしないこと。

# 3. D1 データベースを作る
pnpm --filter @u18/auth-worker exec wrangler d1 create u18-identity
#    出力された database_id を apps/auth-worker/wrangler.jsonc の
#    "database_id": "REPLACE_WITH_D1_DATABASE_ID" と差し替える。
#    この置換を忘れると wrangler dev も migrate も失敗する。
pnpm --filter @u18/nfc-worker exec wrangler d1 create u18-nfc
#    NFC 用は**別の D1**。apps/nfc-worker/wrangler.jsonc の
#    "REPLACE_WITH_NFC_D1_DATABASE_ID" と差し替える。
#    Identity と同じ DB にしないこと（D1 binding に行レベルの粒度が無く、
#    同居させると nfc-worker の侵害が sessions の露出になる）。

# 4. Cloudflare の binding 型を再生成する
pnpm cf-typegen
#    各 app の worker-configuration.d.ts（vars と binding の Env 型）を作り直す。
#    tsconfig.json の types がこのファイルを参照しているので、
#    欠けていると typecheck が TS2688 で落ちる。
#    wrangler.jsonc の binding や vars を増減したら必ず再実行する。
#    なお Workers Secret は wrangler types からは見えないため、
#    apps/auth-worker/worker-env.d.ts で手書き宣言している（生成対象外）。

# 5. マイグレーションを適用する
pnpm db:generate            # packages/db と packages/nfc-db の両方を生成する
                            # Identity: 0000_fat_thunderbird.sql ほか（13 テーブル）
                            # NFC:      0000_first_spirit.sql（2 テーブル）
                            # スキーマを変えたときだけ再実行する
pnpm db:migrate:local       # Identity D1 (miniflare) へ適用
pnpm db:migrate:local:nfc   # NFC D1 へ適用（別 DB なので別コマンド）

# 6. 開発サーバー
pnpm dev                # auth-worker → http://localhost:8787
pnpm dev:dashboard      # dashboard-worker（別ターミナル）
pnpm dev:nfc            # nfc-worker（別ターミナル。--port で空きポートを指定する）
```

動作確認:

```bash
curl http://localhost:8787/health
curl http://localhost:8787/.well-known/openid-configuration
curl http://localhost:8787/login   # ログイン画面（HTML）

pnpm lint       # クリーンに通る
pnpm typecheck  # 6 パッケージすべて通る
pnpm test       # 617 件（domain 25 / auth-worker 477 / dashboard-worker 26 / nfc-worker 89）
```

これが現在のグリーンな基準値。手元で落ちたら、自分の変更かセットアップ
（手順 3・4）の漏れを先に疑うこと。

> **セッション Cookie の取り方**: ブラウザで `http://localhost:8787/login` を開き、
> メール OTP でログインする。`wrangler dev` では Cloudflare Email Sending が
> シミュレートされ、実送信されない代わりにコードを含むメール本文のファイルパスが
> dev のログへ出る。そこから 6 桁のコードを読んで入力する。
> 事前に `users` テーブルへ対象のアドレスを持つ行が要る（未登録のアドレスには
> コードを送らない設計のため。仕様書 9）。
> テストから使う場合は `sessions` テーブルへ直接行を入れてもよい。やり方は
> `apps/auth-worker/test/session-repository.test.ts` と
> `packages/testing/src/fixtures.ts` を参照。

`pnpm dev:dashboard` 単体では RPC 先が存在しないため
`/account/api/me` が 503（`identity_unavailable`）になる。
Service Binding をローカルで通すには auth-worker を先に `pnpm dev` で
起動しておくこと。

> **dashboard-worker のパスには `/account` 接頭辞が要る**（#106）。
> 本番の Workers route は `auth.under18.dev/account/*` で、Cloudflare は
> 一致した接頭辞を URL から取り除かない。つまり Worker には
> `/account/api/me` がそのまま届くので、ハンドラもその形で登録してある。
> **開発時も同じパスを叩くこと**（`http://localhost:<port>/account/api/me`）。
> 接頭辞なしは 404 になる。エンドポイントは
> `/account/health`、`/account/api/me`、`/account/api/me/sessions`、
> `/account/api/me/grants` とそれぞれの `DELETE`。

---

## OIDC Code Flow を手元で 1 周する

ブラウザは要らない。`curl` だけで認可からトークンまで通せる。

```bash
pnpm db:migrate:local
pnpm --filter @u18/auth-worker client:seed-dev   # 検証用クライアント 2 つ（runbook §9.4）
pnpm --filter @u18/auth-worker key:generate --apply-local  # 署名鍵（runbook §9.5）
pnpm dev
```

**ポートが埋まっていたら `--port` で空きを指定する。** その場合は `ISSUER` も
一緒に動かすこと。`ISSUER` は ID Token の `iss` であると同時に form POST の
Origin 検証の基準でもあるので、ポートだけずらすとログインの form が 403 になる。

```bash
cd apps/auth-worker
npx wrangler dev --port 8799 \
  --var ISSUER:http://localhost:8799 \
  --var WEBAUTHN_ORIGIN:http://localhost:8799
```

手順は次の通り。

1. `users` へ検証用のアドレスを 1 行入れる（未登録のアドレスには OTP を
   送らない設計のため。仕様書 9）。
2. `GET /login` で CSRF トークンと Cookie を取り、`POST /login/start` →
   dev ログに出るメール本文のパスから 6 桁を読む → `POST /login/verify` で
   セッション Cookie を得る。form POST には `Origin` ヘッダが要る。
3. `code_verifier` を作り、その SHA-256 の base64url を `code_challenge` として
   `GET /oauth/authorize?...&code_challenge_method=S256` を叩く。
   third-party クライアント（`u18-e2e-local`）なら同意画面の HTML が返り、
   first-party（`u18-dashboard-local`）なら同意を飛ばして `302`/`303` で
   `redirect_uri?code=...&state=...` へ返る。
4. 同意画面から `POST /oauth/consent`（`decision=allow` と CSRF トークン）。
5. `POST /oauth/token` に `grant_type=authorization_code` / `code` /
   `redirect_uri` / `code_verifier` を渡す。confidential なら
   `-u 'client_id:client_secret'`（`client_secret_basic`）でも
   ボディの `client_secret`（`client_secret_post`）でもよいが、**両方を同時に
   付けると 400 になる**（RFC 6749 §2.3.1）。
6. 返ってきた `id_token` を `/.well-known/jwks.json` の公開鍵で検証する。

つまずきやすいところ:

- **`redirect_uri` は完全一致。** 末尾スラッシュが 1 つ違うだけで、authorize は
  リダイレクトせずにエラー画面（400）を返す。これは仕様どおりの挙動で、
  未検証の宛先へエラーを返さないため（RFC 6749 §4.1.2.1）。
- **`code_challenge_method=S256` は省略できない。** 省略を `plain` とみなす
  RFC 7636 の既定にも、黙って S256 と解釈する実装にも寄せていない。
- **認可コードは 60 秒で、1 回しか使えない。** 2 回目は `invalid_grant` になり、
  **1 回目に発行した Access Token も失効する**（RFC 9700 のリプレイ対応）。
  試行錯誤中にこれを踏んだら、authorize からやり直すこと。
- 署名鍵を入れ忘れると `/oauth/token` が 500 `server_error` を返す
  （`/.well-known/jwks.json` のほうは 503）。手順の `key:generate` を飛ばしていないか確認する。

---

## スクリプト

ルートの `package.json` から実行する。

| コマンド                                      | 内容                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm dev`                                    | auth-worker を `wrangler dev` で起動する（既定で :8787）。先に Auth UI の JS を作る              |
| `pnpm dev:dashboard`                          | dashboard-worker を `wrangler dev` で起動する                                                    |
| `pnpm dev:nfc`                                | nfc-worker を `wrangler dev` で起動する。8787 / 8788 と衝突するので `--port` を足す              |
| `pnpm build`                                  | 全 workspace の `build`。Worker は `wrangler deploy --dry-run --outdir dist` でバンドル検証する  |
| `pnpm typecheck`                              | 全 workspace で `tsc --noEmit`。`cf-typegen` 済みであることが前提                                |
| `pnpm lint`                                   | ルートから `eslint .`。レイヤ依存ルール（`packages/config/eslint.layers.js`）を含む              |
| `pnpm lint:fix`                               | 上記を `--fix` 付きで実行する                                                                    |
| `pnpm format`                                 | Prettier で全体を整形する                                                                        |
| `pnpm test`                                   | 全 workspace のテスト。Worker 側は `cloudflareTest()` プラグインで workerd 上の vitest           |
| `pnpm cf-typegen`                             | `apps/*` で `wrangler types` を実行し `worker-configuration.d.ts` を再生成する                   |
| `pnpm --filter @u18/auth-worker build:client` | Auth UI のクライアントアイランドだけを esbuild でバンドルする（通常は上記が自動で呼ぶ）          |
| `pnpm db:generate`                            | Drizzle スキーマからマイグレーション SQL を生成する（`packages/db` と `packages/nfc-db` の両方） |
| `pnpm db:migrate:local`                       | Identity のマイグレーションをローカル D1 へ適用する                                              |
| `pnpm db:migrate:remote`                      | 同じく Cloudflare 上の D1 へ適用する。本番に当たるため実行前に差分を確認すること                 |
| `pnpm db:migrate:local:nfc`                   | NFC のマイグレーションをローカル D1 (`u18-nfc`) へ適用する                                       |
| `pnpm db:migrate:remote:nfc`                  | 同じく Cloudflare 上の `u18-nfc` へ適用する                                                      |

スキーマを変更したときは `pnpm db:generate` → `pnpm db:migrate:local` の順。
生成物（`packages/db/drizzle/*.sql` と `packages/nfc-db/drizzle/*.sql`）はコミットする。
テストは wrangler ではなくこの SQL を直接流すので、生成を忘れるとテストと実装の
スキーマがずれる。Identity と NFC は**別の D1 で別のマイグレーション列**なので、
適用コマンドも別（上表）。同じ `migrations_dir` を指すと、片方の DB に
もう片方のテーブルが生える。

---

## リポジトリ構成

```text
services/
├── apps/
│   ├── auth-worker/              OIDC + 認証 API。Identity D1 の唯一の所有者
│   │   ├── src/
│   │   │   ├── presentation/http/    Hono ルート、Cookie、エラー応答
│   │   │   ├── presentation/http/ui/ Auth UI（hono/jsx の SSR + クライアントアイランド）
│   │   │   ├── presentation/rpc/     IdentityRPC（WorkerEntrypoint）
│   │   │   ├── application/ports/    Port のインターフェース定義
│   │   │   ├── application/use-cases/ ユースケースと認可判断
│   │   │   ├── domain/               Entity / Domain Service / Domain Error
│   │   │   ├── infrastructure/       Drizzle Repository、死活確認、Web Crypto、メール送信
│   │   │   └── composition/          Env から具象実装を組み立てる唯一の場所
│   │   ├── scripts/build-client.mjs  アイランドを esbuild でバンドルする（下の節）
│   │   ├── test/                 workerd 上の単体 / 統合テスト（setup.ts で migration 適用）
│   │   ├── tsconfig.client.json  アイランドだけを DOM の型つきで検査する
│   │   ├── vitest.config.ts      cloudflareTest プラグイン + migration の Node 側読み込み
│   │   ├── wrangler.jsonc        D1 binding、compatibility_date、vars、Secrets 一覧（コメント）
│   │   ├── worker-env.d.ts       Workers Secret の型宣言（手書き。cf-typegen の対象外）
│   │   └── .dev.vars.example     ローカル用シークレットの雛形
│   ├── dashboard-worker/         アカウント設定 UI / BFF。D1 binding は持たない
│   │   └── src/
│   │       ├── index.ts              Hono アプリとルート
│   │       ├── application/ports.ts  IdentityGateway
│   │       ├── domain/errors.ts      IdentityFailure
│   │       └── infrastructure/rpc/   Service Binding adapter
│   └── nfc-worker/               NFC カードの短縮 URL と管理 API。NFC 専用 D1 の所有者
│       ├── src/
│       │   ├── index.ts              Worker のエクスポートだけ（薄い層）
│       │   ├── presentation/http/    Hono ルート、Origin / CSRF、リダイレクト解決
│       │   ├── application/ports.ts  IdentityGateway / CardRepository / ClaimCodeService
│       │   ├── application/use-cases/ 所有者判定を含むユースケース
│       │   ├── domain/               Card Entity と遷移先 URL の検証
│       │   ├── infrastructure/       Drizzle Repository、Service Binding adapter、Web Crypto
│       │   └── composition/          Env から具象実装を組み立てる唯一の場所
│       ├── test/                 workerd 上のテスト（setup.ts で NFC の migration を適用）
│       └── wrangler.jsonc        NFC D1 binding、2 つの route、compatibility_date
├── packages/
│   ├── contracts/                Worker 間 RPC の DTO・zod スキーマ・エラー契約・Cookie 名・バージョン
│   ├── domain/                   3 Worker で共有する純粋な Value Object（Clock, Id, Email, Username）
│   ├── db/                       Identity の Drizzle スキーマとマイグレーション。D1 アクセス実装は置かない
│   ├── nfc-db/                   NFC 専用の Drizzle スキーマとマイグレーション（Identity とは別 D1）
│   ├── config/                   共有 tsconfig と ESLint のレイヤ境界ルール
│   └── testing/                  テスト用 fixture と FixedClock の再エクスポート
├── tests/                        e2e / oidc-conformance / security（いずれも未着手の空ディレクトリ）
├── docs/                         仕様書・アーキテクチャ・脅威モデル・Runbook
├── eslint.config.js              ルート ESLint。末尾でレイヤ境界ルールを展開する
├── tsconfig.base.json            strict 系オプションの基点
└── pnpm-workspace.yaml           workspace 定義、peer 設定、allowBuilds、minimumReleaseAgeExclude
```

---

## このコードはどこに置くか

層を間違えると lint で落ちるので、書き始める前に決めること。
判断に迷ったら「この型はフレームワークを知っているか」を基準にする。

**Domain**（`apps/*/src/domain/`）
業務ルールそのもの。「セッションは失効または期限切れなら使えない」「username に
予約語は使えない」のような、Cloudflare でも Hono でも Drizzle でも変わらない判断。
import できるのは同じ Domain 内のファイルだけで、上記 3 つと `@u18/db` は
ESLint が禁止している。
複数の Worker から本当に共有したい純粋な Value Object だけ `packages/domain/` へ。

**Application**（`apps/*/src/application/use-cases/`）
「誰が」「何をしてよいか」を決める層。認可判断と処理の順序はここに書く。
外界が必要になったら、直接呼ばずに `application/ports/` へインターフェースを
足してコンストラクタで受け取る。戻り値は例外ではなく `UseCaseResult<T>`。
Hono / Drizzle / `cloudflare:*` の import は ESLint が禁止している。
「ヘルスチェックのための `select 1`」程度でも Port を足した実例が
[docs/architecture.md](./docs/architecture.md) §3.4 にある。

**Infrastructure**（`apps/*/src/infrastructure/`）
Port の実装。SQL、Web Crypto、外部 API、Service Binding 呼び出し。
Drizzle の行型は必ず `toDomain()` で Entity へ写し替え、外へ漏らさない。
この層にだけフレームワーク依存が許される。

**Presentation**（`apps/*/src/presentation/`）
HTTP と RPC の入口。リクエストの読み取り、DTO 検証、UseCase の呼び出し、
応答の組み立てとステータスコードへの翻訳。ビジネス上の判断は書かない。
`drizzle-orm` と `infrastructure/persistence/**` の import は ESLint が禁止している。
Hono と `cloudflare:workers` は許される。

**composition**（`apps/auth-worker/src/composition/container.ts`）
`Env` を読んでよい唯一の場所。新しい Port を足したらここで配線する。

**contracts**（`packages/contracts/`）
Worker 境界を越える型だけ。auth-worker の内部型をそのまま置かない。
RPC の DTO に限らず、「両 Worker が一致していないと壊れる値」——
セッション Cookie 名など——もここで共有する。
変更したら `CONTRACT_VERSION` とデプロイ順を確認する
（[docs/architecture.md](./docs/architecture.md) §5.3）。
DTO に機密を増やすときは、dashboard-worker がそれをそのままブラウザへ返しうる
ことを前提に判断する（`SessionListItem` から `ipHash` を外したのはこの理由）。

**db**（`packages/db/` と `packages/nfc-db/`）
テーブル定義のみ。クエリを書く実装はそのテーブルを所有する Worker の
Infrastructure に置く。Identity と NFC は**別パッケージ・別 D1・別マイグレーション**で、
互いに import しない。分離の理由は「将来分けやすいから」ではなく、
D1 binding に行レベルの粒度が無い以上、同じ DB を共有した時点で
nfc-worker の侵害が `sessions` の露出になるため
（`packages/nfc-db/src/schema/cards.ts` に詳述）。

---

## Auth UI（ログイン画面）

ログイン画面は **auth-worker 自身から配信する**（仕様書 14-1 の決定 4 / #36）。
セッション Cookie を発行するホストと同一オリジンでなければならず、別の
フロントエンドに出すと Cookie 境界と CSRF 境界が増えるため。
実体は `apps/auth-worker/src/presentation/http/ui/`。

| パス                      | 内容                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `GET /login`              | ログイン画面。ログイン済みならその旨とログアウト導線を出す      |
| `POST /login/start`       | メール OTP の送信（form POST）                                  |
| `POST /login/verify`      | OTP の検証とセッション発行（form POST）                         |
| `POST /login/logout`      | UI 用のログアウト。303 でログイン画面へ戻す                     |
| `GET /ui/u18.css`         | スタイルシート                                                  |
| `GET /ui/login-island.js` | Passkey のクライアントアイランド                                |
| `POST /oauth/consent`     | 同意画面の送信先（form POST）。画面は `/oauth/authorize` が返す |

同意画面（`ui/consent-page.tsx`）はログイン画面と `ui/layout.tsx`・
スタイルシート・CSP（`ui/page-headers.ts`）・CSRF（`ui/csrf.ts`）を共有する。
**JS は 1 行も使わない。** 認可の可否を決める画面が JS の読み込み失敗で
操作不能になるのを避けるため。

未ログインで `/oauth/authorize` に来ると `/login?return_to=...` へ送られ、
ログイン後に元の認可要求へ戻る。`return_to` は **`/oauth/authorize` で始まる
相対パスだけ**を通す許可制（`ui/return-to.ts`）。「同一オリジンなら」でも
「相対パスなら」でもないのは、`//evil.test/` と `/\evil.test` がブラウザに
よって別オリジンの絶対 URL として解釈されるため。

HonoX は入れていない。ファイルベースルーティングと Vite 前提の構成が、
この repo の Layered Architecture（ESLint が強制）と `wrangler.jsonc` に
噛み合わないため。HonoX が内部で使っているのと同じ `hono/jsx` +
`hono/jsx/dom` を直接使っている。

### JS 無しで成立する範囲

**メール OTP でのログインは JavaScript を 1 行も必要としない。** 画面は
`hono/jsx` のサーバーレンダリングで、2 段の form はどちらも通常の POST。
JS が要るのは `navigator.credentials.get()` を呼ぶ Passkey のボタンだけで、
そこだけを `hono/jsx/dom` のアイランドに切り出してある。認証基盤の
ログイン画面が JS の読み込み失敗で丸ごと使えなくなるのを避けるため。

form POST は **Origin 検証 + CSRF トークン**の二重で守る。JSON API は
`isAllowedOrigin()` だけで足りる（`fetch` は必ず Origin を送る）が、
HTML の form では Origin の付き方がブラウザ・設定に依存するため、
fail-closed な Origin 検証だけに寄せると正規の利用者が締め出される側に倒れる。
詳細は `ui/csrf.ts` のコメント。

### CSP との関係

`app.ts` の `secureHeaders()` は既定では CSP を出さない。ログイン画面には
`ui/login.routes.tsx` で **CSP を足している**（既存の設定は緩めていない）:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'
```

`'unsafe-inline'` も nonce も使わない。その結果としてインライン `<script>` と
インライン `<style>` を一切置けないので、アイランドもスタイルシートも外部
ファイルとして配信している。CSP に引っかかったら、緩めるのではなく外部
ファイルへ出すこと。`test/login.ui.test.ts` が `'unsafe-inline'` の混入と
インライン `<script>` の出現を落として止める。

### クライアント JS のビルド

`apps/auth-worker/scripts/build-client.mjs`（esbuild）が
`ui/client/login-island.tsx` をブラウザ向けにバンドルし、
`ui/generated/login-island.bundle.ts` へ **TypeScript の文字列定数**として吐く。
配信は通常の Hono ルート（`GET /ui/login-island.js`）。

Workers Assets（`wrangler.jsonc` の `assets`）を使わなかったのは 2 つの理由から:

1. 静的ファイルが Worker より先にリクエストを拾う経路が増える。ログイン画面の
   ためだけにルーティングの優先順位を 1 段増やしたくない。
2. `pnpm test` は workerd 上の vitest で走るので、アセットサーバーの挙動まで
   含めて同じように再現できるとは限らない。

文字列定数にしておけば、`pnpm dev` / `pnpm test` / `pnpm build` のどれでも
「ただのモジュール」として同じように解決される。

**生成物はコミットしない**（`.gitignore` 済み）。ログイン画面で動く JS が
ソースと食い違っている状態を作りたくないため。代わりに auth-worker の
`dev` / `build` / `typecheck` / `test` がすべてこのスクリプトを先に実行する
ので、古いバンドルのまま検査が通ることは起こらない。手で作り直したいときは:

```bash
pnpm --filter @u18/auth-worker build:client
```

アイランドの型検査は `tsconfig.client.json` で別に行う。本体の
`tsconfig.json` に `lib: ["DOM"]` を足すと、workerd には存在しない
`document` / `window` が Domain 層からも見えてしまい、動かないコードが
型検査を通ってしまうため（上の「その他」の最後の項目と同じ理由）。

### アカウントの存在を漏らさない

既存の `StartEmailOtpUseCase` は未登録のアドレスでも成功と同じ応答を返し、
`PasskeyLoginOptionsUseCase` は入力を一切受け取らない（`allowCredentials` を
返さない）。**UI 側でこれを台無しにしないこと**（仕様書 9 Privacy）。具体的には:

- 「送信しました」と断定しない。常に「登録されている場合」と条件付きで書く
- OTP 検証の失敗は、不一致・期限切れ・試行上限・形式不正をすべて同じ文言・
  同じステータス（400）に畳む。上限だけ 429 にすると「そのアドレス宛に
  コードを出した」＝登録済み、と分かる
- Passkey ログインにメールアドレスやユーザー識別子を渡す口を作らない。
  どの Credential を使うかはブラウザ / OS の選択 UI に任せる
- 「パスキーが登録されていません」の類を表示しない

`test/login.ui.test.ts` が、登録済みと未登録で応答が 1 バイトも変わらないこと
（入力されたアドレス自身を除く）を固定している。

---

## NFC カード（Phase 4）

文化祭で配る NFC タグには固定の短縮 URL を焼き、遷移先はサーバー側で差し替える
（仕様書 10 / #30 / #31）。`apps/nfc-worker/` がこれを受け持つ。

```text
NFC タグ → https://go.under18.dev/c/<random-card-id>
        → nfc-worker が所有者の設定を引く
        → 所有者が設定した https: の URL へ 302
```

### 2 つのホストに載る 1 つの Worker

| 入口                                   | 役割            | 認証                     |
| -------------------------------------- | --------------- | ------------------------ |
| `go.under18.dev/c/*`                   | 短縮 URL の解決 | しない（誰でもかざせる） |
| `auth.under18.dev/account/nfc/cards/*` | カード管理 API  | セッション Cookie が必須 |

管理 API を短縮 URL 側のホストに置けないのは、セッション Cookie が `__Host-`
接頭辞で Domain 属性を持てず、発行ホスト（`auth.under18.dev`）にしか
送られないため。`go.under18.dev` に置くとログイン済みでも永久に 401 になる。

`go.under18.dev` は**既定の想定であって、実在のドメインとして確定していない**。
配布物に URL を印刷する前にゾーンと route の割り当てを確認すること。

### 守っている不変条件

- **カード ID はユーザー ID と独立**した 100bit の乱数。タグを読んでも `sub` は分からない
- **タグ自体は資格情報ではない。** 紐づけには「セッション」と「タグに書かれていない
  紐づけコード」の両方が要る。カード ID を知っているだけでは自分のものにできない
- **遷移先は `https:` のみ。** URL 内の資格情報、IP リテラル、イントラネット名、
  既定以外のポート、IdP 自身のオリジンはすべて拒否する
  （`apps/nfc-worker/src/domain/services/target-url.ts` に理由を書いてある）
- **ここで登録された URL を OIDC の `redirect_uri` として許可しない。**
  所有者がいつでも書き換えられる値なので、認可コードの宛先に使うと
  IdP 公認のオープンリダイレクタになる
- **解決できないカードは、理由を問わず同じ 404。** 未発行・未紐づけ・無効化済み・
  遷移先未設定で応答が 1 バイトも変わらない（仕様書 9 の列挙対策）
- **リダイレクトは 302 + `no-store`。** 301 を返すとブラウザが対応付けを無期限に
  キャッシュし、遷移先の変更も紛失時の無効化もその端末には届かなくなる

### 所有権の移転と紛失

- **紛失** → `POST .../cards/:cardId/disable`。片道の操作で、所有者は自分で戻せない
- **譲渡** → `POST .../cards/:cardId/release` で手放すと、新しい紐づけコードが
  **1 度だけ**返る。それを手渡しで受け取った相手が `POST .../cards/claim` する。
  相手の userId を指定する API にしていないのは、ユーザー検索の RPC を
  足したくないため（Binding を持つ Worker から任意のユーザーを引ける入口になる）

### カードの発行

発行（`CardRepository.issue()`）は HTTP に出していない。管理者ロールが未実装
（仕様書 14-8）で、「運営だけが実行できる」を表現する手段がまだ無いため。
現状は運用スクリプト／`wrangler d1 execute` で入れる前提。

---

## 文書

- [docs/u18-identity-spec.md](./docs/u18-identity-spec.md) — 仕様書。要件、OIDC・セキュリティ要求、実装フェーズ
- [docs/architecture.md](./docs/architecture.md) — 実装済みアーキテクチャ、レイヤ強制、RPC 契約、実装状況
- [docs/threat-model.md](./docs/threat-model.md) — 脅威モデル
- [docs/runbook.md](./docs/runbook.md) — 運用手順
