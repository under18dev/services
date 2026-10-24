# 標準クライアントライブラリでの疎通 — 2026-10-25

**すべて通過。** `openid-client` が文句を言った点は 1 つも無い。

|            |                                                                              |
| ---------- | ---------------------------------------------------------------------------- |
| 実行日     | 2026-10-25                                                                   |
| ライブラリ | `openid-client@6.8.8`（Filip Skokan / `panva`。OpenID Certified の RP 実装） |
| 流した先   | ローカルの `wrangler dev`（**本番ではない**）                                |
| スクリプト | `openid-client-probe.mjs`                                                    |

## なぜ適合性スイートと別にやるのか

**見ているものが違う。**

- 適合性スイートは「**仕様に適合しているか**」を見る
- このテストは「**実在の RP が実際に使うライブラリで繋がるか**」を見る

適合していても繋がらないことはありうる。ライブラリが仕様より厳しい既定を
持つ場合がそれで、たとえば `openid-client` は平文 HTTP の issuer を
既定で拒否する（下記）。

u18 の RP は当面すべて内製で、Node で書くならほぼ確実にこのライブラリを使う。
**つまりこれは適合性の確認ではなく、最初の実クライアントの疎通確認**である。

## 結果

```
[1] Discovery
    OK  issuer = http://127.0.0.1:8790
    OK  jwks_uri = http://127.0.0.1:8790/.well-known/jwks.json
    OK  id_token_signing_alg_values_supported = ["ES256"]

[2] PKCE と nonce をライブラリに作らせる
    OK  code_challenge_method = S256

[3] 認可 URL をライブラリに組ませる
    OK  http://127.0.0.1:8790/oauth/authorize?...（8 パラメータ）

[4] ブラウザの代わりに認可 → 同意を通す
    OK  認可応答: http://localhost:9876/callback?code=…&state=…

[5] トークン交換と ID Token 検証（ライブラリのロジック）
    OK  token_type = bearer, expires_in = 600
    OK  受け取ったフィールド = access_token, expires_in, id_token, scope, token_type
    OK  ID Token の検証を通過（iss/aud/exp/nonce はライブラリが検証済み）
    OK  sub = usr_…  iss = http://127.0.0.1:8790  aud = u18-openid-client-probe

[6] UserInfo
    OK  UserInfo の sub が ID Token と一致: true
    OK  返ってきた claim = email, email_verified, name, preferred_username, sub, updated_at

=== すべて通過 ===
```

**ID Token の検証はライブラリに任せている。** 自分で JWT を検証すると
「ライブラリで繋がるか」ではなく「自分の実装同士が噛み合うか」を
見ることになるので、JWKS の取得・署名検証・`iss` / `aud` / `exp` / `nonce` の
照合はすべて `authorizationCodeGrant()` の中で行われたものである。

**決定 10（RS256 を広告しない）は、このライブラリでは問題にならなかった。**
`id_token_signing_alg_values_supported: ["ES256"]` をそのまま受け入れ、
ES256 の署名を検証している。

## 気づいた点（不具合ではない）

- **`token_type` が小文字の `bearer`。** RFC 6749 §5.1 は `token_type` を
  大文字小文字を区別しないと定めており、`openid-client` も受け入れた。
  ただし**厳密に `"Bearer"` を期待する実装は世の中にある**ので、
  外部 RP を開く場合（#39）は意識しておく価値がある。
- **`openid-client` は平文 HTTP の issuer を既定で拒否する。**
  ローカル検証なので `allowInsecureRequests` を明示して許した。
  本番は https なので該当しない。**この既定は、適合性スイートの
  「http スキーム」指摘と同じことをライブラリ側でもやっている**例である。

## 再現手順

### 1. クライアントを登録する（ループバック宛は明示的に許可が要る）

```sh
pnpm --filter @u18/auth-worker client:create \
  --client-id u18-openid-client-probe --name "openid-client probe" \
  --type confidential --redirect-uri "http://localhost:9876/callback" \
  --allow-loopback-http
```

`--allow-loopback-http` を付けないと `insecure_scheme` で拒否される。
このフラグは `--remote` と併用できない（本番 IdP にループバック宛の
クライアントを残さないため）。

### 2. ログインしてセッション Cookie を得る

`2026-10-24-basic-op.md` の「3. ログインを通す」と同じ。
`purpose: "signup"` で始めること、`send_email` を外した設定で
`wrangler dev` を起動すること、OTP は observability API から取ること。

### 3. 走らせる

```sh
cd <scratch>; npm init -y; npm install openid-client
ISSUER=http://127.0.0.1:8790 \
CLIENT_ID=u18-openid-client-probe \
CLIENT_SECRET=<登録時に一度だけ表示される値> \
SESSION_COOKIE='u18_session=<値>' \
node openid-client-probe.mjs
```

**依存をリポジトリに足していない。** `openid-client` は検証用の
スクラッチディレクトリにだけ入れてある。CI に常設していないのは、
外部サービスへの依存を増やさないため（#28 の方針）。
