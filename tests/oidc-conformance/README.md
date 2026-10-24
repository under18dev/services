# OIDC 適合性テスト

仕様書 11.3 / 13 の「OIDC 準拠確認」に対応する（#28）。

自前のアサーションではなく、公開されている標準テストスイートで確認する。
独自実装のテストだけでは「自分の解釈どおりに動く」ことしか確かめられず、
他実装との相互運用性を保証できないため。

このファイルはスイートの選定と前提条件。**実行記録は日付ごとの別ファイル**に置く。

| 実行記録                  | プラン    | 結果                                        |
| ------------------------- | --------- | ------------------------------------------- |
| `2026-10-24-config-op.md` | Config OP | FAILED（実バグ 1 件 = #112、環境由来 7 件） |

---

## 1. 使うスイート

**OpenID Foundation Conformance Suite**（Java 実装）。
2020 年 8 月に旧 Python 実装を置き換えたもので、現在の正本はこれ。

- 実行そのものは無料
- **認証（certification）の取得にだけ**費用と申請手続きが要る
- ソース: <https://gitlab.com/openid/conformance-suite>
- 公式手順: <https://openid.net/certification/connect_op_testing/>

### 該当するプロファイル

| プロファイル            | 要否 | 理由                                                                                                     |
| ----------------------- | ---- | -------------------------------------------------------------------------------------------------------- |
| **Basic OP**            | 必要 | `response_type=code` のみなので、該当する認証プロファイルはこれだけ                                      |
| **Config OP**           | 必要 | Discovery ドキュメントの検査。#28 の受け入れ条件「Discovery の広告内容と実装の差分がゼロ」に直接対応する |
| Implicit OP / Hybrid OP | 不要 | その `response_type` を公開していない                                                                    |
| Dynamic OP              | 不要 | 動的クライアント登録を持たない                                                                           |
| Form Post OP            | 不要 | `response_modes_supported` が `["query"]` のみ                                                           |
| Logout OP               | 保留 | 手順が別。ログアウト仕様の実装状況が固まってから判断する                                                 |

---

## 2. どこに向けて流すか

**hosted 版と自前ホスト版で前提がまったく違う。**
#28 の issue 本文には「公開到達可能な issuer を要求する」と書いてあるが、
**それは hosted 版に限った話**である。

### 2.1 自前ホスト版（まずこちら）

Docker で手元に立てる。この場合、**`wrangler dev` に向けて流せる**。
本番ドメインも D1 も要らないので、**#5 とデプロイ一式を待たずに着手できる**。

**Maven ビルドは不要だった。** 公式のビルド済みイメージがリポジトリ内の
compose ファイルで参照されている。

```sh
git clone https://gitlab.com/openid/conformance-suite.git
cd conformance-suite
git checkout release-v5.3.3
IMAGE_TAG=release-v5.3.3 docker compose -f docker-compose-prebuilt.yml up -d
# https://localhost.emobix.co.uk:8443 で待ち受ける
```

手順の全体と、流す先（`wrangler dev`）の立て方は
`2026-10-24-config-op.md` の「再現手順」に実際に動いた形で書いてある。

### 2.2 hosted 版（認証を取るとき）

<https://www.certification.openid.net/> に Google か GitLab のアカウントで入る。

- **OIDF 側のサーバから我々の issuer に到達できる必要がある。**
  つまり `auth.under18.dev` が生きていること（#5 とデプロイ一式が前提）
- 全クライアントに
  `https://www.certification.openid.net/test/a/<ALIAS>/callback`
  を redirect URI として登録する
- `ALIAS` は他の利用者と衝突すると**テストが互いに干渉する**。
  組織名など固有の値を選び、早めに押さえる

---

## 3. テスト用クライアントの登録

動的クライアント登録を持たないので、**手動で 3 つ**登録する（公式手順）。

1. `client_secret_basic` のクライアント
2. もう 1 つ `client_secret_basic` のクライアント
   （認可コードがクライアントに束縛されていることの検査に要る）
3. `client_secret_post` のクライアント。
   1 と同じクライアントが両方式を使えるなら兼用でよい

`token_endpoint_auth_methods_supported` は
`["client_secret_basic", "client_secret_post", "none"]` なので要件は満たしている。
**1 つのクライアントが basic と post の両方を使えるか**は未確認。
使えるなら登録は 2 つで済む。

登録には `apps/auth-worker/scripts/oauth-client.mjs`（`pnpm --filter @u18/auth-worker client:create`）が使える想定。

---

## 4. PKCE —— 認証を狙わないという決定

**Basic OP プランの大半のテストは `code_challenge` を送らない。**
OIDC Core 自体が PKCE を要求していないため。
PKCE を送るのは `oidcc-ensure-request-with-valid-pkce-succeeds` だけ。

u18 は認可の入口で無条件に弾く。

```
apps/auth-worker/src/application/use-cases/authorize-request.use-case.ts
  return reject("invalid_request", "code_challenge is required");
```

つまり **Basic OP プランのほぼ全テストが `/authorize` で `invalid_request` になる。**
certification は全テストが PASSED / REVIEW / WARNING / SKIPPED のいずれかである
必要があり、FAILED が 1 つでもあればそのプロファイルは認証されない。

### 決定: PKCE 必須を維持し、Basic OP の認証取得を狙わない

「適合性テストを通すために PKCE を免除する」という回避策を採らない。理由は 3 つ。

1. **PKCE 必須は仕様書 §5.1 / §9 の明示要求。**
   しかも「public クライアントだけ PKCE」と読める記述が並んで存在するなかで、
   別途書かれている。読み違いではなく意図された強い要求である。
2. **RFC 9700 §2.1.1（仕様書 §9 が従うと宣言している）はクライアント種別を
   問わず PKCE を要求する。** Basic OP が PKCE を送らないのは
   **OIDC Core が PKCE より前の仕様だから**であって、
   PKCE 無しが正しいからではない。規範が食い違うとき、新しくて厳しい側を捨てない。
3. **クライアント単位の免除フラグは、立っていることに気づく手段が無い。**
   PKCE 無しでも認可は成功するので、挙動は正常に見える。
   #88 で「宣言された上限が一度も発動しない」形を直したばかりで、
   同じ構図を自分から作ることになる。

RFC 7636 は「`code_challenge` 無しで発行したコードに `code_verifier` が
提示されたら拒否する」ことも要求しているが、**免除経路でしか通らない分岐は
普段テストされない**。他プロジェクトがここを素通りしたのは必然であり、
免除を入れない理由をさらに補強する。

認証（certification）を狙わないのは、仕様書が求めているのが
§11.3「標準テストスイートで**確認**」・§13「OIDC **準拠確認**」であって
認証の取得ではないこと、そして外部開発者向けの公開 Developer Portal を
作らない（§1.2 非目標）ため**バッジが効く相手がいない**ことによる。

### それでも Basic OP を流す

通らないと分かっていても流す。**目的は合格ではなく、
落ちる理由が PKCE 必須「だけ」であることの証明**である。

- 各 FAILED について、`code_challenge` を付ければ通ることを個別に確認する
- **PKCE 以外の理由で落ちた項目は、実バグとして起票する**

これをやらないと「PKCE のせいで落ちている」が点検されない仮説のまま残り、
その陰に実際の不具合が隠れる。

**Config OP は PKCE に依存しないので、落ちてよい理由が無い。完全に通す。**

## 5. 実行前に塞ぐ必要がある穴

| 項目                     | 状態           | Basic OP       | Config OP |
| ------------------------ | -------------- | -------------- | --------- |
| PKCE の扱い（§4）        | **未決**       | 止まる         | 影響なし  |
| `/oauth/userinfo` が 501 | #17 待ち       | 止まる         | 影響なし  |
| `/oauth/revoke` が 501   | #17 待ち       | **止まらない** | 影響なし  |
| `jwks_uri`               | 実装済み (#14) | OK             | OK        |

`/oauth/revoke` が Basic OP を止めないのは、トークン失効が RFC 7009 であって
OIDC Core の範囲外だから。**#28 の前提になるのは #17 のうち userinfo だけ。**

### Discovery が 501 のエンドポイントを広告している

`userinfo_endpoint` と `revocation_endpoint` は Discovery に出ているが、
どちらも 501 を返す。Config OP はフィールドの存在しか見ないはずなので
通る見込みだが、**標準 RP から見れば「あると言われた機能が無い」状態**である。
#17 で解消される。

---

## 6. 既知の引っかかりどころ

以下は他実装からの報告であり、我々の実装で再現するかは未確認。
実際に流したときに結果で置き換えること。

- **`jwks_uri` が無いと全テストが `FetchServerKeys` で error になる。**
  #14 で実装済みなので該当しない。ES256 も Basic OP の範囲内。
- **`oidcc-prompt-none-logged-in` / `oidcc-max-age-10000` / `oidcc-id-token-hint`**
  は「既にログイン済み」を前提にしており、`login_required` を返すと落ちる。
  `prompt` と `max_age` は #99 で実装済みなので、流して挙動を見るのが早い。
- **`oidcc-id-token-hint` は落ちる見込み。`id_token_hint` を実装していない**
  （Discovery にも出していない）。これが落ちた場合、**PKCE とは無関係な
  実差分**なので §4 の「実バグとして起票」に該当する。
  落ちた理由を PKCE のせいにしないこと。
- **不透明 Access Token は Basic OP では問題にならないはず。**
  OIDC Core は Access Token の形式を規定しておらず、UserInfo が Bearer として
  受け付けられれば足りる。ただし**これは推測であって、公式に明言した記述は
  見つけられなかった。** 自前ホストで流せば確定する。

---

## 7. CI に載せるか

公式には `scripts/run-test-plan.py` で CI から流せるとあり、
OIDF 自身が認可サーバの開発者に推奨している。

ただし**常設するかは別途判断したい。** 外部サービスへの依存が増え、
PR ごとに流すには遅い。**手動実行 + 結果のコミットで #28 の受け入れ条件は
満たせる**ので、まずはそこまでをやる。

---

## 8. 記録するもの

実行したら、このディレクトリに以下を残す。

- 実行日、スイートのバージョン（git の commit か tag）
- 使ったプロファイルと、流した先（自前ホスト / hosted、向けた issuer）
- 合否の一覧
- **落ちた項目それぞれについて、issue 化したか、意図的な非対応か**
- 使ったクライアント設定（**client secret は含めない**）
