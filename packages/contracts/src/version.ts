/**
 * RPC 契約のバージョン。
 *
 * 破壊的変更を入れるときは MAJOR を上げ、呼び出し元 Worker を先にデプロイできるよう
 * 旧メソッドを 1 バージョン分は残す（仕様書 4.4「RPC 契約変更時は後方互換性を確認し、
 * Worker のデプロイ順を管理する」）。
 *
 * ## 1.0.0 → 1.1.0（#18: `listGrants` / `revokeGrant`、#44: `ping` の追加）
 *
 * **後方互換な追加**なので MINOR を上げる。既存 4 メソッドの署名・意味・DTO は
 * どれも変えていない。したがって **auth-worker（呼び出し先）を先にデプロイする**
 * （docs/architecture.md §5.3）。逆順にすると、新しい dashboard-worker が
 * まだ `listGrants` を持たない auth-worker を呼び、Service Binding が
 * 「そのメソッドは無い」で throw する。`RpcIdentityGateway.call()` がそれを
 * `identity_unavailable` へ畳むので画面は 503 で済むが、同意管理だけが
 * 無言で壊れた状態がデプロイ完了まで続く。
 *
 * ## 消費者は 2 つある
 *
 * `IdentityRpcContract` を読む Worker は dashboard-worker **と nfc-worker** の
 * 2 つで、どちらも `packages/contracts` に依存している。今回足したのは
 * インターフェースへの**メソッド追加**であって、nfc-worker が使っている
 * `getSession` には触れていない。nfc-worker 側は契約を `implements` せず
 * スタブを `IdentityRpcContract` として**読む**だけなので、メソッドが増えても
 * 型は壊れず、再デプロイも要らない。
 *
 * この非対称性が MAJOR 変更では逆転する。メソッドの削除や意味の変更を入れると
 * **両方**の消費者を揃えてデプロイし直す必要があり、「dashboard だけ直せばよい」
 * という以前の前提はもう成り立たない。
 */
/**
 * ## 1.1.0 → 1.2.0（#22: `caller` の追加）
 *
 * 書き込みを伴う 6 メソッドの入力に **optional** な `caller` を足した。
 * 監査ログの `actor` に入れ、dashboard-worker と nfc-worker の
 * どちらから来た操作かを後から辿れるようにする。
 *
 * **後方互換な追加**なので MINOR。optional にしてあるのは、必須にすると
 * auth-worker を先にデプロイした瞬間に古い呼び出し元が全滅するため。
 * 渡されなければ `actor` は `"unknown"` になる。
 *
 * デプロイ順は従来どおり **auth-worker が先**。逆順にすると、新しい
 * 呼び出し元が `caller` を送っても古い auth-worker は zod の
 * `safeParse` で未知のキーを落とすだけなので**壊れはしない**が、
 * その間の監査ログは `actor` が空のままになる。
 *
 * **`caller` は認証ではない。** Service Binding は呼び出し元の身元を
 * 運ばないので、これは自己申告である。認可の判断に使わないこと
 * （`identity.ts` の `RPC_CALLERS` のコメント）。
 */
export const CONTRACT_VERSION = "1.2.0" as const;
export type ContractVersion = typeof CONTRACT_VERSION;
