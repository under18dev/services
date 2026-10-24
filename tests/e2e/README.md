# E2E テスト

仕様書 11.3 に対応する、プロトコル全体を通したテストを置く。

Phase 2 以降に追加するもの:

- 2 つ以上の独立した OIDC クライアントからの SSO
- 正常な Code Flow + PKCE、ID Token と JWKS の検証
- 不正な Client / Redirect URI / Scope / PKCE / nonce / state の拒否
- セッション失効とログアウトの反映
- Passkey の登録・ログイン・紛失復旧

Worker 単位の統合テストは各 app の `test/` に置く。ここに置くのは
**複数 Worker をまたぐ、あるいは外部クライアント視点の**テストだけにする。
