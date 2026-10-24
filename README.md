# u18 Identity

u18 の複数の Web サービスで共通利用する OpenID Connect Identity Provider。
Cloudflare Workers 上で動作し、認証情報の正本は Cloudflare D1（Drizzle ORM）に置く。
pnpm workspaces の monorepo で、`auth-worker`（OIDC と認証 API、Identity D1 の所有者）と
`dashboard-worker`（アカウント設定 UI / BFF）の 2 つの Worker を Service Bindings の RPC で
つないでいる。各 Worker の内部は Presentation / Application / Domain / Infrastructure に
分かれ、依存方向は ESLint で強制される。現在は仕様書 12 の Phase 1 の途中で、
OIDC エンドポイントとログイン手段（Passkey / メール OTP）は未実装である
（詳細は [docs/architecture.md](./docs/architecture.md) §6）。

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

### vitest 4.1.12

`@cloudflare/vitest-pool-workers@0.23.0` の peer が
`vitest: "^4.1.0"` / `@vitest/runner: "^4.1.0"` / `@vitest/snapshot: "^4.1.0"`。
vitest 5 系へ上げると内部 API が合わず、`apps/*/vitest.config.ts` が
`cloudflareTest()` プラグインの読み込み時点で落ちる。
Workers ランタイム上でテストを走らせている以上、vitest 側ではなく
`@cloudflare/vitest-pool-workers` 側の対応バージョンに追従する。

なお 0.23.0 で `defineWorkersConfig()` は廃止され、通常の `defineConfig()` に
`plugins: [cloudflareTest({...})]` を渡す形に変わっている。古い記事や
以前のこのリポジトリのコードを参考にして `defineWorkersConfig` へ戻さないこと。
インストール時に「`@cloudflare/vitest-plugin` へ改称された」という警告が出るが、
改称先への移行はまだ行っていない。

### `compatibility_date` = `2026-08-15`

`apps/*/wrangler.jsonc` の `compatibility_date` は**今日の日付ではない**。
これはバージョン固定と同じ性質の制約なので、ここに書いておく。

テストは `@cloudflare/vitest-pool-workers` が同梱する workerd 上で走る。
その workerd のビルド日より後の `compatibility_date` を指定すると、
テストが 1 件も実行されずに起動時点で `ERR_FUTURE_COMPATIBILITY_DATE` で落ちる。
`wrangler dev` と `wrangler deploy` は新しい日付でも通ってしまうため、
「ローカルの dev は動くのに `pnpm test` だけ全滅する」という形で現れる。

日付を進めたいときは、`@cloudflare/vitest-pool-workers`（と間接依存の miniflare）を
先に上げて、同梱 workerd がその日付を知っている状態にしてから上げる。
両 Worker の `wrangler.jsonc` に同じ趣旨のコメントを置いてある。

### その他

- `@cloudflare/workers-types@5.20261023.1` は `pnpm-workspace.yaml` の
  `minimumReleaseAgeExclude` に入れてある。Cloudflare のランタイム型は
  `compatibility_date` に追従して頻繁に出るため、公開直後でも取得できるようにしている。
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

# 4. Cloudflare の binding 型を再生成する
pnpm cf-typegen
#    各 app の worker-configuration.d.ts（vars と binding の Env 型）を作り直す。
#    tsconfig.json の types がこのファイルを参照しているので、
#    欠けていると typecheck が TS2688 で落ちる。
#    wrangler.jsonc の binding や vars を増減したら必ず再実行する。
#    なお Workers Secret は wrangler types からは見えないため、
#    apps/auth-worker/worker-env.d.ts で手書き宣言している（生成対象外）。

# 5. マイグレーションを適用する
pnpm db:generate        # packages/db/src/schema/ → packages/db/drizzle/*.sql
                        # 生成済み（0000_fat_thunderbird.sql、13 テーブル）なので
                        # スキーマを変えたときだけ再実行する
pnpm db:migrate:local   # ローカル D1 (miniflare) へ適用

# 6. 開発サーバー
pnpm dev                # auth-worker → http://localhost:8787
pnpm dev:dashboard      # dashboard-worker（別ターミナル）
```

動作確認:

```bash
curl http://localhost:8787/health
curl http://localhost:8787/.well-known/openid-configuration
curl http://localhost:8787/login   # ログイン画面（HTML）

pnpm lint       # クリーンに通る
pnpm typecheck  # 6 パッケージすべて通る
pnpm test       # 232 件（packages/domain 25、dashboard-worker 21、auth-worker 186）
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

`pnpm dev:dashboard` 単体では RPC 先が存在しないため `/api/me` が
503（`identity_unavailable`）になる。Service Binding をローカルで通すには
auth-worker を先に `pnpm dev` で起動しておくこと。

---

## スクリプト

ルートの `package.json` から実行する。

| コマンド                                      | 内容                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm dev`                                    | auth-worker を `wrangler dev` で起動する（既定で :8787）。先に Auth UI の JS を作る             |
| `pnpm dev:dashboard`                          | dashboard-worker を `wrangler dev` で起動する                                                   |
| `pnpm build`                                  | 全 workspace の `build`。Worker は `wrangler deploy --dry-run --outdir dist` でバンドル検証する |
| `pnpm typecheck`                              | 全 workspace で `tsc --noEmit`。`cf-typegen` 済みであることが前提                               |
| `pnpm lint`                                   | ルートから `eslint .`。レイヤ依存ルール（`packages/config/eslint.layers.js`）を含む             |
| `pnpm lint:fix`                               | 上記を `--fix` 付きで実行する                                                                   |
| `pnpm format`                                 | Prettier で全体を整形する                                                                       |
| `pnpm test`                                   | 全 workspace のテスト。Worker 側は `cloudflareTest()` プラグインで workerd 上の vitest          |
| `pnpm cf-typegen`                             | `apps/*` で `wrangler types` を実行し `worker-configuration.d.ts` を再生成する                  |
| `pnpm --filter @u18/auth-worker build:client` | Auth UI のクライアントアイランドだけを esbuild でバンドルする（通常は上記が自動で呼ぶ）         |
| `pnpm db:generate`                            | Drizzle スキーマからマイグレーション SQL を `packages/db/drizzle/` に生成する                   |
| `pnpm db:migrate:local`                       | 生成済みマイグレーションをローカル D1 へ適用する                                                |
| `pnpm db:migrate:remote`                      | 同じく Cloudflare 上の D1 へ適用する。本番に当たるため実行前に差分を確認すること                |

スキーマを変更したときは `pnpm db:generate` → `pnpm db:migrate:local` の順。
生成物（`packages/db/drizzle/*.sql`）はコミットする。テストは wrangler ではなく
この SQL を直接流すので、生成を忘れるとテストと実装のスキーマがずれる。

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
│   └── dashboard-worker/         アカウント設定 UI / BFF。D1 binding は持たない
│       └── src/
│           ├── index.ts              Hono アプリとルート
│           ├── application/ports.ts  IdentityGateway
│           ├── domain/errors.ts      IdentityFailure
│           └── infrastructure/rpc/   Service Binding adapter
├── packages/
│   ├── contracts/                Worker 間 RPC の DTO・zod スキーマ・エラー契約・Cookie 名・バージョン
│   ├── domain/                   両 Worker で共有する純粋な Value Object（Clock, Id, Email, Username）
│   ├── db/                       Drizzle スキーマとマイグレーション。D1 アクセス実装は置かない
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

**db**（`packages/db/`）
テーブル定義のみ。クエリを書く実装はそのテーブルを所有する Worker の
Infrastructure に置く。

---

## Auth UI（ログイン画面）

ログイン画面は **auth-worker 自身から配信する**（仕様書 14-1 の決定 4 / #36）。
セッション Cookie を発行するホストと同一オリジンでなければならず、別の
フロントエンドに出すと Cookie 境界と CSRF 境界が増えるため。
実体は `apps/auth-worker/src/presentation/http/ui/`。

| パス                      | 内容                                                       |
| ------------------------- | ---------------------------------------------------------- |
| `GET /login`              | ログイン画面。ログイン済みならその旨とログアウト導線を出す |
| `POST /login/start`       | メール OTP の送信（form POST）                             |
| `POST /login/verify`      | OTP の検証とセッション発行（form POST）                    |
| `POST /login/logout`      | UI 用のログアウト。303 でログイン画面へ戻す                |
| `GET /ui/u18.css`         | スタイルシート                                             |
| `GET /ui/login-island.js` | Passkey のクライアントアイランド                           |

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

## 文書

- [docs/u18-identity-spec.md](./docs/u18-identity-spec.md) — 仕様書。要件、OIDC・セキュリティ要求、実装フェーズ
- [docs/architecture.md](./docs/architecture.md) — 実装済みアーキテクチャ、レイヤ強制、RPC 契約、実装状況
- [docs/threat-model.md](./docs/threat-model.md) — 脅威モデル
- [docs/runbook.md](./docs/runbook.md) — 運用手順
