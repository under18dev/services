# E2E テスト

仕様書 11.3 に対応する、プロトコル全体を通したテストを置く。

Phase 2 以降に追加するもの:

- ~~2 つ以上の独立した OIDC クライアントからの SSO~~ → 下記（#20 で実施済み）
- 正常な Code Flow + PKCE、ID Token と JWKS の検証
- 不正な Client / Redirect URI / Scope / PKCE / nonce / state の拒否
- セッション失効とログアウトの反映
- Passkey の登録・ログイン・紛失復旧

Worker 単位の統合テストは各 app の `test/` に置く。ここに置くのは
**複数 Worker をまたぐ、あるいは外部クライアント視点の**テストだけにする。

## 2 クライアント SSO は `apps/auth-worker/test/` にある（#20）

Phase 2 の完了条件「独立した 2 サービスから『Sign in with u18』により認証できる」は
**`apps/auth-worker/test/sso-two-clients.test.ts`** が検証する。
このディレクトリではない。

`tests/` は `pnpm-workspace.yaml` の `packages:` に含まれておらず、
ルートの `pnpm test`（= `pnpm -r test`）から走らない。ここに置くには
workspace への追加と vitest 設定の新設が要るが、確かめたいもの
（`/oauth/authorize` の同意分岐・実 D1 上の `oauth_grants` / `oauth_tokens`・
ID Token の署名）はすべて auth-worker 単体の中で完結しており、
**`@cloudflare/vitest-plugin` の設定を 2 つ持つ理由にならない。**
設定が 2 つあれば、`compatibility_date` や `TEST_MIGRATIONS` の受け渡しが
片方だけ古くなる形でずれていく。

単回交換の競合（#19）を `apps/auth-worker/test/oauth-code-concurrency.test.ts` に
置いたのと同じ判断である（`docs/architecture.md` §9-4）。
CI から外れるテストは「無いのと同じ」なので、実行されない場所には置かない。

ここを使うのは、**複数の Worker を同時に動かす必要が出てから**でよい
（dashboard-worker を RP として実際に起動する、など）。

```bash
# ルートの 1 コマンドで走る（他は何も要らない）
pnpm test

# この 1 本だけ
pnpm --filter @u18/auth-worker test sso-two-clients
```

## 実機（`wrangler dev`）で 1 周する手順

自動テストは `createApp()` を直接叩くので、`wrangler dev` 固有の配線
（Secret の読み込み・`send_email` バインディング・実 D1 ファイル）は通らない。
リリース前やこのあたりを触ったときは手でも 1 周しておく。

```bash
pnpm --filter @u18/auth-worker migrate:local
pnpm --filter @u18/auth-worker key:generate --apply-local   # 出力の SIGNING_KEY_JWK を .dev.vars へ
pnpm --filter @u18/auth-worker client:seed-dev              # 2 クライアントを投入（runbook §9.4）
```

**ポートは必ず `--port` で明示する。** 既定の 8787 は他のプロジェクトと
衝突しやすく、衝突してもエラーにならず先約の Worker に当たる
（別 Worker の応答を自分のものだと誤読する事故が実際に起きている）。
ポートを変えたら `ISSUER` も合わせること。Discovery・`iss`・Origin 検証が
これを見るので、ずれると同意の POST が 403 になる。

```bash
cd apps/auth-worker
npx wrangler dev --port 8893 \
  --var ISSUER:http://localhost:8893 --var WEBAUTHN_ORIGIN:http://localhost:8893
```

1. `POST /api/auth/email/start` → OTP は `wrangler dev` がシミュレートした
   メール本文（ログに出るパス `.wrangler/tmp/email/**/email-text/*.txt`）に出る
2. `POST /api/auth/email/verify` → `u18_session` Cookie
3. `GET /oauth/authorize?client_id=u18-dashboard-local&...` → **同意画面を挟まず** 303 + `code`
4. `POST /oauth/token`（`client_secret=dev-only-secret-dashboard`）→ `id_token`
5. **同じ Cookie のまま** `GET /oauth/authorize?client_id=u18-e2e-local&...`
   → **200（同意画面）**。ここが `303 /login?return_to=...` なら SSO が壊れている
6. `POST /oauth/consent`（`decision=allow`・`u18_csrf` の double-submit）→ 303 + `code`
7. `POST /oauth/token`（public なので `client_secret` 無し・PKCE のみ）→ `id_token`
8. `/.well-known/jwks.json` を取得して両方の ID Token を検証する。
   `sub` が一致し、`aud` が `u18-dashboard-local` / `u18-e2e-local` で分かれること
9. `POST /api/auth/logout` → 204。その後 3 と 5 がどちらも
   `303 /login?return_to=...` になること

終わったら `wrangler dev` を**必ず止める**。
