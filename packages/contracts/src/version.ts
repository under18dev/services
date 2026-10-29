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
/**
 * ## 1.2.0 → 1.3.0（#11 / #75: アカウント API を RPC へ出す）
 *
 * `updateProfile` / `listPasskeys` / `deletePasskey` を足した。dashboard から
 * プロフィール更新と Passkey 管理ができるようになる（仕様書 8.1）。
 *
 * **後方互換な追加**なので MINOR。既存 7 メソッドの署名・意味・DTO は
 * 変えていない。デプロイ順は従来どおり **auth-worker が先**。
 *
 * **`RpcErrorCode` に 2 つ足した。** `reauthentication_required` と
 * `conflict`。これは**呼び出し元が増やした分岐を扱えないと意味が無い**
 * 変更である —— 古い dashboard は未知のコードを `identity_unavailable` へ
 * 畳むので、利用者には「障害」と見える（正しくは「もう一度ログイン」）。
 * **壊れはしないが、デプロイ順を逆にすると案内が間違う。**
 */
/**
 * ## 1.3.0 → 1.4.0（#187: `isAdmin` と `AccountApiErrorCode`）
 *
 * `SessionSummary` と `UserProfile` に `isAdmin` を足した。**消費者が
 * 違うので両方に置いてある** —— nfc-worker は発行の可否に 1 ビットだけ
 * 要り、`getUserProfile` を呼ばせるとメールアドレスまで渡る（#187）。
 *
 * `ACCOUNT_API_ERROR_CODES` は、UI が失敗種別の網羅を型で強制するための
 * 公開ユニオン。**ここへ足すと UI がビルドで落ちる**ようにしてある。
 *
 * **後方互換な追加**なので MINOR。デプロイ順は auth-worker が先。
 */
/**
 * ## 1.4.0 のまま変えない（RR-5: `isAdmin` を Passkey セッションに限る）
 *
 * `SessionSummary.isAdmin` と `UserProfile.isAdmin` が、**Passkey で
 * 張られたセッションでしか true にならなく**なった（仕様書 §14.1 決定 8）。
 * 意味は狭まっているが、番号は動かさない。
 *
 * **MAJOR が要るのは「消費者を揃えてデプロイし直す必要があるとき」である。**
 * 冒頭の「意味の変更は MAJOR」はその言い換えで、理由も同じ場所に書いてある
 * —— 「両方の消費者を揃えてデプロイし直す必要があり、『dashboard だけ
 * 直せばよい』という以前の前提はもう成り立たない」。条件のほうを見る。
 *
 * この変更では成り立たない。型も項目も増減せず、値は**狭まる方向にしか
 * 動かない**ので、消費者のコードは 1 行も変わらない。デプロイ順も従来どおり
 * auth-worker が先でよく、**逆順でも壊れない**（古い auth-worker が広い
 * `isAdmin` を返す間が続くだけで、それは今の状態そのものである）。
 *
 * **MINOR でもない。** このファイルの MINOR は一貫して「後方互換な**追加**」で、
 * 今回は何も足していない。上げると、1.5.0 を見た人が「何が増えたのか」を
 * 探して見つけられない。
 *
 * 意味が変わったことは `identity.ts` の各 `isAdmin` と脅威モデル RR-5 に
 * 書いた。**番号を動かさないぶん、そちらは必ず書く。**
 */
/**
 * ## 1.4.0 → 1.5.0（#318: 本人の退会）
 *
 * `closeAccount` を足した。本人が自分のアカウントを閉じられるようにする
 * （それまで経路が 1 つも無かった。ランブック §11.7）。
 *
 * **後方互換な追加**なので MINOR。既存メソッドの署名・意味・DTO は
 * 変えていない。デプロイ順は従来どおり **auth-worker が先**。
 *
 * **`status` は `suspended` になる。`deleted` ではない。** 個人情報は
 * 落ちないので、呼び出し元は「削除しました」と言ってはならない
 * （§11.7 の応対原則）。`deleted` を立てると `purgeUserSql` の
 * `status <> 'deleted'` に弾かれ、**管理者が二度と落とせなくなる。**
 */
/**
 * ## 1.5.0 → 1.6.0（#308: OAuth クライアント管理を RPC へ出す）
 *
 * `listOAuthClients` / `createOAuthClient` / `disableOAuthClient` を足した。
 * これまで `scripts/oauth-client.mjs` からしかできなかった登録・失効を、
 * **管理者のセッションでだけ**画面から行えるようにする。
 *
 * **これはメソッドの追加であると同時に、緩和策の置き換えである。**
 * 「運用者の手元からしか叩けない」を「管理者だけが叩ける」に替えており、
 * 弱くなる方向の変更にあたる（`docs/threat-model.md` RR-21）。契約の形で
 * 効かせているのは 3 点 —— `OAuthClientSummary` に `client_secret_hash` を
 * 置かないこと、平文の `client_secret` を `createOAuthClient` の応答に
 * しか置かないこと、`createOAuthClient` の入力に **`isFirstParty` を
 * 置かないこと**（同意画面の省略は登録とは別の権限で、こちらのほうが
 * 重い。経路は `scripts/oauth-client.mjs` だけに残す）。
 * **認可と再認証の判定は契約では表現できない**ので、auth-worker の
 * UseCase の中に置いてある —— 登録と失効には再認証が要り、
 * `reauthentication_required`（1.3.0 で足したコード）が返る。
 *
 * **後方互換な追加**なので MINOR。デプロイ順は従来どおり auth-worker が先。
 * 逆順にすると、新しい dashboard-worker がまだメソッドを持たない
 * auth-worker を呼び、`RpcIdentityGateway.call()` が
 * `identity_unavailable` へ畳む —— 画面は 503 で済むが、管理領域だけが
 * 無言で壊れた状態がデプロイ完了まで続く。
 *
 * **番号は 1.6.0 である。** この変更を書いたときは 1.5.0 のつもりだったが、
 * 先に #318（退会）が 1.5.0 を取って main へ入った。リベースで繰り上げた
 * ——  **同じ番号に 2 つの意味が付くと、`CONTRACT_VERSION` を見ても
 * どちらが入っているか分からなくなる。**
 */
export const CONTRACT_VERSION = "1.6.0" as const;
export type ContractVersion = typeof CONTRACT_VERSION;
