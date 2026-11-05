import { rpcErr, rpcOk, RpcErrorCode } from "@u18/contracts";
import type {
  GetUsersByIdsDelegatedInput,
  IdentityAdminDelegatedRpcContract,
} from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { resolveUserRefs } from "../src/presentation/http/user-refs";
import { minimalIdentityAdmin } from "./helpers";

const ACTOR = "usr_admin";

function fakeIdentityAdmin(
  getUsersByIds: IdentityAdminDelegatedRpcContract["getUsersByIds"],
): IdentityAdminDelegatedRpcContract {
  return { ...minimalIdentityAdmin(), getUsersByIds };
}

describe("resolveUserRefs（#471）", () => {
  it("null と重複と空文字を、呼ぶ前に落とす", async () => {
    const calls: GetUsersByIdsDelegatedInput[] = [];
    const identityAdmin = fakeIdentityAdmin(async (input) => {
      calls.push(input);
      return rpcOk([]);
    });

    await resolveUserRefs(identityAdmin, ACTOR, ["usr_a", null, "usr_a", "", "usr_b", null]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.userIds.sort()).toEqual(["usr_a", "usr_b"]);
  });

  it("全部 null/空なら、RPC を 1 回も呼ばない", async () => {
    let called = false;
    const identityAdmin = fakeIdentityAdmin(async () => {
      called = true;
      return rpcOk([]);
    });

    const refs = await resolveUserRefs(identityAdmin, ACTOR, [null, "", null]);

    expect(called).toBe(false);
    expect(refs.size).toBe(0);
  });

  it("解決できた分だけ Map に入る。見つからなかった ID は入らない", async () => {
    const identityAdmin = fakeIdentityAdmin(async () =>
      rpcOk([{ id: "usr_a", username: "a", displayName: "A", status: "active" as const }]),
    );

    const refs = await resolveUserRefs(identityAdmin, ACTOR, ["usr_a", "usr_missing"]);

    expect(refs.size).toBe(1);
    expect(refs.get("usr_a")?.username).toBe("a");
    expect(refs.has("usr_missing")).toBe(false);
  });

  it("RPC が例外を投げても、空の Map を返す（一覧そのものは落とさない）", async () => {
    const identityAdmin = fakeIdentityAdmin(async () => {
      throw new Error("service binding unreachable");
    });

    const refs = await resolveUserRefs(identityAdmin, ACTOR, ["usr_a"]);

    expect(refs.size).toBe(0);
  });

  it("RPC が ok: false を返しても、空の Map を返す", async () => {
    const identityAdmin = fakeIdentityAdmin(async () => rpcErr(RpcErrorCode.Internal, "boom"));

    const refs = await resolveUserRefs(identityAdmin, ACTOR, ["usr_a"]);

    expect(refs.size).toBe(0);
  });

  it("100 件を超えたら複数回に分けて呼ぶ。片方が失敗しても、もう片方の結果は生かす", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `usr_${i}`);
    const calls: GetUsersByIdsDelegatedInput[] = [];
    const identityAdmin = fakeIdentityAdmin(async (input) => {
      calls.push(input);
      if (calls.length === 1) throw new Error("最初のチャンクだけ落ちる");
      return rpcOk(
        input.userIds.map((id) => ({
          id,
          username: id,
          displayName: id,
          status: "active" as const,
        })),
      );
    });

    const refs = await resolveUserRefs(identityAdmin, ACTOR, ids);

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.userIds.length <= 100)).toBe(true);
    // 1 回目（最初の 100 件）は落ちた。2 回目（残り 50 件）だけ生きている。
    expect(refs.size).toBe(50);
  });
});
