import type { IdentityRpcContract, RpcError, RpcResult, RpcCaller } from "@u18/contracts";
import type { IdentityGateway, IdentityOutcome } from "../../application/ports";
import type { IdentityFailure } from "../../domain/errors";

/**
 * Service Binding のスタブを契約インターフェースとして見る。
 *
 * `wrangler types` は別 Worker の Entrypoint を知らないため、binding は
 * `Fetcher` としか型付けできない。実際の形の保証は呼ばれる側にあり、
 * auth-worker の `IdentityRPC` が `implements IdentityRpcContract` で
 * コンパイル時に検査されている。ここはその契約を信じる 1 箇所に絞る。
 */
export function asIdentityRpc(binding: Fetcher): IdentityRpcContract {
  return binding as unknown as IdentityRpcContract;
}

/** `pingIdentity` の待ち時間の上限（ミリ秒）。 */
const PING_TIMEOUT_MS = 2_000;

/**
 * 一定時間で諦める。
 *
 * 失敗を reject で表すのは、`RpcIdentityGateway.call()` の catch が
 * そのまま `identity_unavailable` へ畳んでくれるため。ここで独自の
 * 失敗値を作ると、翻訳の経路が 2 本になる。
 *
 * **タイムアウトしても元の呼び出しは止まらない**（Workers の RPC に
 * キャンセルは無い）。放置された Promise が後から reject すると
 * unhandled rejection になるので、捨てる側で握り潰しておく。
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => undefined);

  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("identity ping timed out")), ms),
    ),
  ]);
}

/** RPC のエラー契約を、この Worker のドメイン語彙へ翻訳する。 */
function toFailure(error: RpcError): IdentityFailure {
  switch (error.code) {
    case "unauthenticated":
      return { kind: "unauthenticated" };
    case "forbidden":
      return { kind: "forbidden" };
    case "not_found":
      return { kind: "not_found" };
    case "invalid_input":
      // 入力の組み立てはこちらの責任なので、ユーザーには障害として見せる。
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
 * RPC の失敗・タイムアウトをここで明示的に扱う（仕様書 4.4）。
 * 冪等でない操作（revokeSession / revokeGrant）を自動リトライしないこと。
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
  private static readonly CALLER = "dashboard-worker" as const satisfies RpcCaller;

  /** 呼び出し元を必ず混ぜる。RPC の入力はここを通して作る。 */
  private input<T extends object>(fields: T): T & { caller: RpcCaller } {
    return { ...fields, caller: RpcIdentityGateway.CALLER };
  }

  getSession(sessionToken: string) {
    return this.call(() => this.identity.getSession(this.input({ sessionToken })));
  }

  getProfile(sessionToken: string) {
    return this.call(() => this.identity.getUserProfile(this.input({ sessionToken })));
  }

  listSessions(sessionToken: string) {
    return this.call(() => this.identity.listSessions(this.input({ sessionToken })));
  }

  revokeSession(sessionToken: string, targetSessionId: string) {
    return this.call(() =>
      this.identity.revokeSession(this.input({ sessionToken, targetSessionId })),
    );
  }

  listGrants(sessionToken: string) {
    return this.call(() => this.identity.listGrants(this.input({ sessionToken })));
  }

  revokeGrant(sessionToken: string, clientId: string) {
    return this.call(() => this.identity.revokeGrant(this.input({ sessionToken, clientId })));
  }

  /**
   * 死活確認（#44）。**ここだけタイムアウトを課す。**
   *
   * 他のメソッドは利用者の操作に紐づくので、遅ければ利用者が待てばよい。
   * `/health` は監視が叩く経路で、応答が返らないこと自体が答えである。
   * 待ち続けると「落ちている」と「遅い」の区別が監視から消える。
   *
   * 2 秒は、Service Binding が同一 colo 内の呼び出しであることから決めた。
   * 正常なら数ミリ秒で返るので、2 秒かかる時点で既に異常である。
   */
  pingIdentity() {
    return this.call(() => withTimeout(this.identity.ping(), PING_TIMEOUT_MS));
  }

  /**
   * RPC 共通の呼び出し。
   *
   * 投げられた例外（Worker の停止・デプロイ中の不整合など）は
   * 「Identity が使えない」に畳み込む。ここで throw を素通しすると、
   * Presentation 層が 500 以外の扱いを選べなくなる。
   */
  private async call<T>(invoke: () => Promise<RpcResult<T>>): Promise<IdentityOutcome<T>> {
    try {
      const result = await invoke();
      if (result.ok) return { ok: true, value: result.value };
      return { ok: false, failure: toFailure(result.error) };
    } catch (cause) {
      console.error("identity rpc call failed", cause);
      return {
        ok: false,
        failure: { kind: "identity_unavailable", detail: "identity service unreachable" },
      };
    }
  }
}
