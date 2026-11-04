import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { PERMISSION_BITS } from "../src/domain/permissions";
import { ORIGIN, executionContext, fakeApprovals, loginAs } from "./helpers";

/**
 * 操作ごとの権限ガード（#190）が実際に効いていることを、HTTP 層で確かめる。
 *
 * `route-permissions.test.ts` は宣言（対応表）の整合だけを見る——
 * ここでは「ビットを持たない相手が実際に 403 になるか」「super approver
 * はバイパスされるか」という、実行時の振る舞いを確かめる。
 */

const SUB = "usr_perm_test";

describe("ビットを持たない相手は 403", () => {
  it("NFC_READ を持たなければ GET /nfc は 403", async () => {
    const approvals = fakeApprovals([SUB], [], { [SUB]: 0n });
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
  });

  it("NFC_READ だけ持っていても、書き込み系（POST /nfc）は 403", async () => {
    const approvals = fakeApprovals([SUB], [], { [SUB]: PERMISSION_BITS.NFC_READ });
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, {
        method: "POST",
        headers: { Cookie: sessionCookie, Origin: ORIGIN },
        body: new URLSearchParams({ count: "1" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
  });
});

describe("ビットを持っていれば通る", () => {
  it("NFC_READ を持っていれば GET /nfc は 403 にならない", async () => {
    const approvals = fakeApprovals([SUB], [], { [SUB]: PERMISSION_BITS.NFC_READ });
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).not.toBe(403);
  });
});

describe("super approver は保存されたビットに関わらずバイパスする", () => {
  it("permissions が 0 でも super なら GET /nfc は 403 にならない", async () => {
    const approvals = fakeApprovals([SUB], [SUB], { [SUB]: 0n });
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).not.toBe(403);
  });
});

describe("対象外の経路は権限を問わない", () => {
  it("ホーム（/）は権限 0 でも 403 にならない", async () => {
    const approvals = fakeApprovals([SUB], [], { [SUB]: 0n });
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });

    const response = await app.fetch(
      new Request(`${ORIGIN}/`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).not.toBe(403);
  });
});

describe("存在しない経路は 404 のまま（403 にしない）", () => {
  it("対応表にも route-inventory にも無いパスは 404", async () => {
    const approvals = fakeApprovals([SUB], [], { [SUB]: 0n });
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });

    const response = await app.fetch(
      new Request(`${ORIGIN}/this-route-does-not-exist`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(404);
  });
});
