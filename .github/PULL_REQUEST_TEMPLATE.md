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
- [ ] `packages/contracts`
- [ ] `packages/domain`
- [ ] `packages/db`（Drizzle schema / migration）
- [ ] `packages/config`
- [ ] `packages/testing`
- [ ] CI / デプロイ設定
- [ ] ドキュメントのみ

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
