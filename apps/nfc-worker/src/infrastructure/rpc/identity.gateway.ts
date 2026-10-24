import type { IdentityRpcContract, RpcError, RpcResult, RpcCaller } from "@u18/contracts";
import type { IdentityGateway, NfcOutcome } from "../../application/ports";
import type { NfcFailure } from "../../domain/errors";

/**
 * Service Binding のスタブを契約インターフェースとして見る。
 *
 * `wrangler types` は別 Worker の Entrypoint を知らないため、binding は
 * `Fetcher` としか型付けできない。実際の形の保証は呼ばれる側にあり、
 * auth-worker の `IdentityRPC` が `implements IdentityRpcContract` で
 * コンパイル時に検査されている。この `as` を 1 箇所に閉じ込める
 * （dashboard-worker の同名ファイルと同じ方針）。
 */
export function asIdentityRpc(binding: Fetcher): IdentityRpcContract {
  return binding as unknown as IdentityRpcContract;
}

/** RPC のエラー契約を、この Worker のドメイン語彙へ翻訳する。 */
function toFailure(error: RpcError): NfcFailure {
  switch (error.code) {
    case "unauthenticated":
      return { kind: "unauthenticated" };
    case "forbidden":
      // nfc-worker が forbidden を受けるのは配線ミス（Binding が
      // 許されていない等）であって、利用者の問題ではない。障害として見せる。
      return { kind: "identity_unavailable", detail: "identity service refused the call" };
    case "not_found":
      return { kind: "unauthenticated" };
    case "invalid_input":
      // 入力の組み立てはこちらの責任。利用者には障害として見せる。
      return { kind: "identity_unavailable", detail: "invalid request to identity service" };
    case "rate_limited":
      return { kind: "identity_unavailable", detail: "identity service is rate limiting" };
    default:
      return { kind: "identity_unavailable", detail: "identity service error" };
  }
}

/**
 * Service Binding 経由で auth-worker を呼ぶ adapter。
 *
 * ## `CONTRACT_VERSION` とデプロイ順（docs/architecture.md 5.3）
 *
 * nfc-worker は `IdentityRpcContract` の**新しい消費者**であって、
 * 契約そのものは一切変えていない。`getSession` は既存のメソッドで、
 * DTO にも手を入れていないため **`CONTRACT_VERSION` は `1.0.0` のまま**。
 * 「後方互換な追加なら MINOR を上げる」の対象は契約（`packages/contracts`）の
 * 変更であって、呼び出し元の追加ではない。
 *
 * ただしデプロイ順の規律はそのまま効く。
 *
 * - 初回デプロイは **auth-worker が先**。`u18-auth-production` に
 *   `IdentityRPC` が無い状態で nfc-worker を出すと、Service Binding の
 *   解決に失敗して起動しない。
 * - 今後 `IdentityRpcContract` を変えるときは、呼び出し元が
 *   dashboard-worker と nfc-worker の **2 つ**になったことに注意する。
 *   旧メソッドを 1 バージョン分残す期間は、両方の切り替えが済むまで。
 * - nfc-worker が auth-worker に新しいメソッドを要求する場合は、
 *   MINOR を上げ、auth-worker → nfc-worker の順でデプロイする。
 *   現時点でその必要は無い（`getSession` だけで足りている）。
 *
 * 型レベルの番人は `IdentityRpcContract` そのもの。auth-worker 側の
 * `IdentityRPC` が `implements` している限り、契約を満たさない変更は
 * `pnpm typecheck` で落ちる。
 */
export class RpcIdentityGateway implements IdentityGateway {
  constructor(private readonly identity: IdentityRpcContract) {}

  /**
   * 監査ログの `actor` に入る呼び出し元の名前（#22）。
   *
   * **全呼び出しに必ず付ける。** 契約上は optional なので、付け忘れても
   * 型は通り、RPC も成功し、`actor` が "unknown" になるだけ —— つまり
   * **壊れたことに気づけない**。付け忘れが起きないよう、呼び出しは
   * すべて `input()` を通す。実際に付いていることはテストが固定している。
   */
  private static readonly CALLER = "nfc-worker" as const satisfies RpcCaller;

  /** 呼び出し元を必ず混ぜる。RPC の入力はここを通して作る。 */
  private input<T extends object>(fields: T): T & { caller: RpcCaller } {
    return { ...fields, caller: RpcIdentityGateway.CALLER };
  }

  getSession(sessionToken: string) {
    return this.call(() => this.identity.getSession(this.input({ sessionToken })));
  }

  /**
   * RPC 共通の呼び出し。
   *
   * 投げられた例外（Worker の停止・デプロイ中の不整合など）は
   * 「Identity が使えない」に畳み込む。素通しすると Presentation 層が
   * 500 以外の扱いを選べなくなる。
   *
   * **リトライしない。** `getSession` は冪等だが、ここで自動リトライを
   * 入れると、将来冪等でないメソッドを足したときに同じ `call()` へ
   * 乗せてしまう（仕様書 4.4）。
   */
  private async call<T>(invoke: () => Promise<RpcResult<T>>): Promise<NfcOutcome<T>> {
    try {
      const result = await invoke();
      if (result.ok) return { ok: true, value: result.value };
      return { ok: false, failure: toFailure(result.error) };
    } catch (cause) {
      // セッショントークンはここに出さない（仕様書 4.2）。
      console.error("identity rpc call failed", cause);
      return {
        ok: false,
        failure: { kind: "identity_unavailable", detail: "identity service unreachable" },
      };
    }
  }
}
