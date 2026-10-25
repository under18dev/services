## 概要

<!-- このPRで何を変更したかを簡潔に記述してください。 -->

## 変更の種類

<!-- 該当するものにxを入れてください。 -->

- [ ] feat: 新機能
- [ ] fix: バグ修正
- [ ] refactor: 挙動を変えないリファクタリング
- [ ] docs: ドキュメントのみの変更
- [ ] test: テストの追加・修正
- [ ] chore / ci: ビルド・CI・依存関係など

## 関連Issue / 仕様

- 関連Issue: <!-- 例: Closes #12 / Refs #34 -->
- 仕様書の該当セクション: <!-- 例: docs/u18-identity-spec.md 5.2 エンドポイント -->
- 実装フェーズ: <!-- Phase 1 / Phase 2 / Phase 3 / Phase 4 / 該当なし -->

## 影響範囲

<!-- 該当するものにxを入れてください。 -->

- [ ] `apps/auth-worker`
- [ ] `apps/dashboard-worker`
- [ ] `apps/nfc-worker`
- [ ] `packages/contracts`
- [ ] `packages/domain`
- [ ] `packages/db`（Identity の Drizzle schema / migration）
- [ ] `packages/nfc-db`（NFC の Drizzle schema / migration）
- [ ] `packages/config`
- [ ] `packages/testing`
- [ ] CI / デプロイ設定
- [ ] ドキュメントのみ

## 横断的な変更と nfc-worker

<!--
auth-worker / dashboard-worker に横断的な手当て（レート制限、キャッシュ制御、
保持期限、監査ログ、ヘッダの既定値など「仕組みとして入れるもの」）を加えた
場合だけ記入してください。単一機能の変更なら「該当なし」で構いません。

**なぜこの欄があるか。** 同じことが 3 回起きています:

  #21  レート制限          → auth / dashboard に入れ、nfc は範囲外
  #43  保持期限            → Identity の 5 テーブルだけ。nfc は掃除が無かった
  #125 no-store の既定化   → auth / dashboard に入れ、nfc は経路ごとに書いたまま

3 回とも「nfc を外す」と決めたのではなく、**思い出さなかった**だけです。
思い出す場所は変更している最中でないと間に合いません（脅威モデル RR-20）。
-->

**nfc-worker に同じものが要るか判断しましたか。要らない場合はその理由を書いてください。**

<!--
チェックボックスにしていないのは、**埋めるのが安すぎる**からです。
「確認した」にチェックを入れるだけなら、確認していなくても通ります。
一文でよいので、判断の中身を書いてください。

例:
  要る  → 同じ PR で nfc-worker にも入れた（`apps/nfc-worker/...`）
  要る  → 別 issue に切り出した（#NNN）。この PR には含めない理由は …
  要らない → nfc-worker に該当する経路が無い（セッションを発行しないため）
  該当なし → 単一機能の変更で、横断的な手当てではない
-->

## セキュリティ考慮

u18 Identityは未成年ユーザーの認証を扱うため、すべてのPRでセキュリティ影響を明示してください。

- [ ] このPRは認証・セッション・トークン・暗号処理に**影響しない**

影響する場合は以下に回答してください（影響しない場合は「該当なし」で可）。

- 認証フローへの影響（Passkey / Email OTP / セッション発行・失効）:
- OIDC / OAuthへの影響（`/authorize`、`/token`、PKCE、Consent、Scope、ID Token検証）:
- トークン・鍵・暗号処理への影響（署名アルゴリズム、鍵ローテーション、Web Crypto利用箇所）:
- 認可チェックへの影響（HTTPエンドポイント / RPC Entrypointごとの権限確認）:

チェックリスト:

- [ ] Secret・資格情報・トークン・`code_verifier`・OTPをログや例外メッセージに出力していない
- [ ] PII（メールアドレス、ユーザーID等）をログに不必要に出力していない
- [ ] 新しい入力はPresentation層でDTO検証している（RPC経由でも省略していない）
- [ ] Redirect URIやURLを扱う変更は、事前登録・厳密一致・`https:`限定の方針に従っている
- [ ] 新しいSecret / Binding / 環境変数を追加した場合、設定手順を記載した
- [ ] レート制限・監査ログが必要な操作であれば考慮した

## アーキテクチャ適合性（仕様書 2.3）

- [ ] 依存方向 `Presentation -> Application -> Domain` を守っている
- [ ] Domain層からHono、Drizzle、Cloudflareの`Env`を参照していない
- [ ] Application層はPortを介してInfrastructureに依存している（具象実装に直接依存していない）
- [ ] 認証DBへの書き込みは`auth-worker`に集約されている
- [ ] D1 の binding を所有者以外の Worker へ渡していない（`u18-identity` は auth-worker、`u18-nfc` は nfc-worker）

## テスト

- [ ] `pnpm typecheck` が通る
- [ ] `pnpm lint` が通る
- [ ] `pnpm test` が通る
- [ ] 追加・変更した挙動に対するテストを書いた（異常系・認可失敗系を含む）

実行したテスト・手動確認の内容:

<!-- 例: vitestの該当スイート、wrangler devでの手動確認手順 -->

## DBマイグレーション

- [ ] このPRにスキーマ変更は**含まれない**
- [ ] スキーマ変更を含み、マイグレーションを生成・確認した（ロールバック方針も記載）

## CI が落ちたとき

`pnpm audit` が落ちている場合、原因はこの PR の変更ではなくアドバイザリの新規公開であることが多い。切り分けと対処は `docs/runbook.md` の §3.4「依存の脆弱性で CI が落ちたとき」を見ること。

`--audit-level` の引き上げ・`--prod` の削除・`continue-on-error` の追加で黙らせないこと。

## レビュー時に見てほしい点

<!-- 設計上の判断、トレードオフ、未決定事項など -->
