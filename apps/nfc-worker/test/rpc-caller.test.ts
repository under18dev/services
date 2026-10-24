import { rpcCallerSchema, type IdentityRpcContract } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { RpcIdentityGateway } from "../src/infrastructure/rpc/identity.gateway";

/**
 * 監査ログの帰属（#22）。dashboard 側と同じ理由で、実際に送っていることを固定する。
 *
 * **消費者が 2 つあることがこの issue の出発点**なので、両方で見る。
 * 片方だけ送っていると、`actor` が "unknown" の行を見たときに
 * 「nfc から来た」のか「送り忘れ」なのか区別できない。
 */
describe("RpcIdentityGateway が呼び出し元を名乗る（nfc-worker）", () => {
  it("getSession が caller を送る", async () => {
    const inputs: Record<string, unknown>[] = [];
    const identity = {
      getSession: (value: unknown) => {
        inputs.push(value as Record<string, unknown>);
        return Promise.resolve({ ok: true as const, value: null });
      },
    } as unknown as IdentityRpcContract;

    await new RpcIdentityGateway(identity).getSession("s".repeat(40));

    expect(inputs[0]?.["caller"]).toBe("nfc-worker");
  });

  it("名乗る値が契約の集合に含まれる", () => {
    expect(rpcCallerSchema.safeParse("nfc-worker").success).toBe(true);
  });
});
