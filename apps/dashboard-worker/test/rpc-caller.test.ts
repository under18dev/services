import { rpcCallerSchema, type IdentityRpcContract } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { RpcIdentityGateway } from "../src/infrastructure/rpc/identity.gateway";

/**
 * 監査ログの帰属（#22）。
 *
 * **契約上 `caller` は optional なので、付け忘れても型は通り、RPC も
 * 成功し、`actor` が "unknown" になるだけ。** 壊れたことに気づけない形
 * なので、実際に送っていることをここで固定する。
 *
 * 「宣言はあるが発動しない」をこのリポジトリで 5 回踏んでいる
 * （#88 / #96 / #122 / #132 / #143）。同じ形を作らない。
 */
describe("RpcIdentityGateway が呼び出し元を名乗る", () => {
  /** 渡された入力を全部覚える fake。 */
  function recording() {
    const inputs: Record<string, unknown>[] = [];
    const capture = (value: unknown) => {
      inputs.push(value as Record<string, unknown>);
      return Promise.resolve({ ok: true as const, value: null });
    };
    const identity = {
      getSession: capture,
      getUserProfile: capture,
      listSessions: capture,
      revokeSession: capture,
      listGrants: capture,
      revokeGrant: capture,
      ping: capture,
    } as unknown as IdentityRpcContract;
    return { inputs, gateway: new RpcIdentityGateway(identity) };
  }

  const TOKEN = "s".repeat(40);

  it("書き込みを伴う全メソッドが caller を送る", async () => {
    const { inputs, gateway } = recording();

    await gateway.getSession(TOKEN);
    await gateway.getProfile(TOKEN);
    await gateway.listSessions(TOKEN);
    await gateway.revokeSession(TOKEN, "ses_x");
    await gateway.listGrants(TOKEN);
    await gateway.revokeGrant(TOKEN, "cli_x");

    expect(inputs).toHaveLength(6);
    for (const input of inputs) {
      expect(input["caller"], `caller の無い呼び出しがある: ${JSON.stringify(input)}`).toBe(
        "dashboard-worker",
      );
    }
  });

  it("名乗る値が契約の集合に含まれる", () => {
    // 閉じた集合から外れると auth-worker 側の safeParse で落ちる。
    // その場合 RPC 全体が invalid_input になるので、ここで止める。
    expect(rpcCallerSchema.safeParse("dashboard-worker").success).toBe(true);
  });
});
