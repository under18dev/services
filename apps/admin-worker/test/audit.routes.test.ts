import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RpcErrorCode, rpcErr, rpcOk } from "@u18/contracts";
import type {
  AuditLogEntryAdmin,
  IdentityAdminDelegatedRpcContract,
  ListAuditLogsDelegatedInput,
} from "@u18/contracts";
import { createApp } from "../src/presentation/http/app";
import { ORIGIN, cookieHeaderFrom, executionContext, fakeApprovals, loginAs } from "./helpers";

/**
 * 監査ログの閲覧画面（`/audit`、#375 / #382 / #390 決定 16 ③）。
 *
 * `users.routes.test.ts` と同じ形。ここは読むだけなので PRG は無い。
 */

const SUB = "usr_admin_audit";

function entry(overrides: Partial<AuditLogEntryAdmin> = {}): AuditLogEntryAdmin {
  return {
    id: "aud_0001",
    event: "ops.user.suspended",
    userId: "usr_0001",
    actor: "admin-worker",
    outcome: "success",
    reason: "abuse",
    metadata: null,
    ipHash: null,
    userAgent: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeIdentityAdmin(overrides: Partial<IdentityAdminDelegatedRpcContract> = {}): {
  readonly rpc: IdentityAdminDelegatedRpcContract;
  readonly calls: { listAuditLogs: ListAuditLogsDelegatedInput[] };
} {
  const calls = { listAuditLogs: [] as ListAuditLogsDelegatedInput[] };

  const rpc: IdentityAdminDelegatedRpcContract = {
    listUsers: async () => rpcOk({ users: [], nextCursor: null }),
    suspendUser: async () => rpcErr(RpcErrorCode.Internal, "unused"),
    reinstateUser: async () => rpcErr(RpcErrorCode.Internal, "unused"),
    revokeUserSessions: async () => rpcErr(RpcErrorCode.Internal, "unused"),
    listOAuthClients: async () => rpcOk([]),
    createOAuthClient: async () => rpcErr(RpcErrorCode.Internal, "unused"),
    disableOAuthClient: async () => rpcErr(RpcErrorCode.Internal, "unused"),
    listAuditLogs: async (input) => {
      calls.listAuditLogs.push(input);
      return rpcOk({ entries: [entry()], nextCursor: null });
    },
    ...overrides,
  };

  return { rpc, calls };
}

async function loginAsApproved(): Promise<string> {
  const approvals = fakeApprovals([SUB]);
  return loginAs(SUB, approvals);
}

function csrfTokenFrom(cookieHeader: string): string {
  const match = /u18_csrf=([^;]+)/.exec(cookieHeader);
  if (match === null) throw new Error("csrf cookie not found");
  return decodeURIComponent(match[1]!);
}

describe("GET /audit", () => {
  it("一覧・CSRF トークンを描く", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      listAuditLogs: async () =>
        rpcOk({ entries: [entry({ event: "ops.admin.granted" })], nextCursor: null }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/audit`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("ops.admin.granted");
    expect(html).toMatch(/name="csrf_token"/);
  });

  it("listAuditLogs が失敗したら 503", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      listAuditLogs: async () => rpcErr(RpcErrorCode.Internal, "boom"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/audit`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(503);
  });
});

describe("POST /audit/search", () => {
  it("CSRF トークンが無ければ 403 で、listAuditLogs を絞り込みでは呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const body = new URLSearchParams({ event: "ops.user.suspended" });
    const response = await app.fetch(
      new Request(`${ORIGIN}/audit/search`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.listAuditLogs).toHaveLength(0);
  });

  it("CSRF が通れば event・user_id・outcome を渡して絞り込む", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/audit`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({
      event: "ops.user.suspended",
      user_id: "usr_taro",
      outcome: "success",
      csrf_token: csrfToken,
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/audit/search`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body,
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(calls.listAuditLogs.at(-1)).toEqual({
      actorUserId: SUB,
      event: "ops.user.suspended",
      userId: "usr_taro",
      outcome: "success",
    });
  });

  it("outcome が success/failure 以外なら渡さない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/audit`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ outcome: "", csrf_token: csrfToken });
    await app.fetch(
      new Request(`${ORIGIN}/audit/search`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body,
      }),
      env,
      executionContext(),
    );

    expect(calls.listAuditLogs.at(-1)).toEqual({ actorUserId: SUB });
  });
});
