import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RpcErrorCode, rpcErr, rpcOk } from "@u18/contracts";
import type {
  IdentityAdminDelegatedRpcContract,
  ListUsersDelegatedInput,
  ListUsersDelegatedResult,
  ReinstateUserDelegatedInput,
  RevokeUserSessionsDelegatedInput,
  SuspendUserDelegatedInput,
  UserAdminSummary,
} from "@u18/contracts";
import { createApp } from "../src/presentation/http/app";
import { ORIGIN, cookieHeaderFrom, executionContext, fakeApprovals, loginAs } from "./helpers";

/**
 * 利用者の管理画面（`/users`、#375 / #382 / #390 決定 16 ③）。
 *
 * **`IdentityAdminDelegatedRPC` 自体はここでは確かめない。** あちらは
 * auth-worker 側の契約テスト（`identity-admin-delegated.rpc.test.ts`）が
 * 持つ。ここで見るのは HTTP 層の責務だけ——CSRF・actorUserId の渡し方・
 * 失敗したときの文言・PRG。
 */

const SUB = "usr_admin_users";

function user(overrides: Partial<UserAdminSummary> = {}): UserAdminSummary {
  return {
    id: "usr_0001",
    username: "taro",
    displayName: "太郎",
    primaryEmail: "taro@example.com",
    emailVerified: true,
    status: "active",
    hasAdminFlag: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeIdentityAdmin(overrides: Partial<IdentityAdminDelegatedRpcContract> = {}): {
  readonly rpc: IdentityAdminDelegatedRpcContract;
  readonly calls: {
    listUsers: ListUsersDelegatedInput[];
    suspendUser: SuspendUserDelegatedInput[];
    reinstateUser: ReinstateUserDelegatedInput[];
    revokeUserSessions: RevokeUserSessionsDelegatedInput[];
  };
} {
  const calls = {
    listUsers: [] as ListUsersDelegatedInput[],
    suspendUser: [] as SuspendUserDelegatedInput[],
    reinstateUser: [] as ReinstateUserDelegatedInput[],
    revokeUserSessions: [] as RevokeUserSessionsDelegatedInput[],
  };

  const rpc: IdentityAdminDelegatedRpcContract = {
    listUsers: async (input): Promise<ListUsersDelegatedResult> => {
      calls.listUsers.push(input);
      return rpcOk({ users: [user()], nextCursor: null });
    },
    suspendUser: async (input) => {
      calls.suspendUser.push(input);
      return rpcOk({ revokedSessions: 2 });
    },
    reinstateUser: async (input) => {
      calls.reinstateUser.push(input);
      return rpcOk({});
    },
    revokeUserSessions: async (input) => {
      calls.revokeUserSessions.push(input);
      return rpcOk({ revokedSessions: 1 });
    },
    listOAuthClients: async () => rpcOk([]),
    createOAuthClient: async () => rpcErr(RpcErrorCode.Internal, "unused"),
    disableOAuthClient: async () => rpcErr(RpcErrorCode.Internal, "unused"),
    listAuditLogs: async () => rpcOk({ entries: [], nextCursor: null }),
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

describe("GET /users", () => {
  it("一覧・CSRF トークンを描く", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      listUsers: async () => rpcOk({ users: [user({ id: "usr_taro" })], nextCursor: null }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/users`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("usr_taro");
    expect(html).toMatch(/name="csrf_token"/);
  });

  it("listUsers が失敗したら 503", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      listUsers: async () => rpcErr(RpcErrorCode.Internal, "boom"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/users`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(503);
  });

  it("停止直後は件数つきの通知を出す（PRG）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/users?notice=suspended&revoked=2`, {
        headers: { Cookie: sessionCookie },
      }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("停止しました");
    expect(html).toContain("2 件");
  });
});

describe("POST /users/search", () => {
  it("CSRF トークンが無ければ 403 で、listUsers を絞り込みでは呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const body = new URLSearchParams({ query: "taro@example.com" });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/search`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.listUsers).toHaveLength(0);
  });

  it("CSRF が通れば query を渡して絞り込む", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ query: "taro@example.com", csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/search`, {
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
    expect(calls.listUsers.at(-1)).toEqual({ actorUserId: SUB, query: "taro@example.com" });
  });
});

describe("POST /users/:userId/suspend", () => {
  it("CSRF トークンが無ければ 403 で、suspendUser を呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const body = new URLSearchParams({ reason: "abuse" });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/suspend`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.suspendUser).toHaveLength(0);
  });

  it("理由を選ばずに送ると画面を描き直し、呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/suspend`, {
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
    expect(calls.suspendUser).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("理由を選んでください");
  });

  it("CSRF が通れば actorUserId・reason 付きで呼び、件数つきで PRG する", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ reason: "abuse", csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/suspend`, {
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

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/users?notice=suspended&revoked=2");
    expect(calls.suspendUser).toEqual([{ actorUserId: SUB, userId: "usr_taro", reason: "abuse" }]);
  });

  it("conflict なら理由を言って画面を描き直す（303 では戻さない）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      suspendUser: async () => rpcErr(RpcErrorCode.Conflict, "already suspended"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ reason: "abuse", csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/suspend`, {
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
    const html = await response.text();
    expect(html).toContain("停止できませんでした");
  });
});

describe("POST /users/:userId/reinstate", () => {
  it("CSRF が通れば actorUserId 付きで呼び、PRG する", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/reinstate`, {
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

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/users?notice=reinstated");
    expect(calls.reinstateUser).toEqual([{ actorUserId: SUB, userId: "usr_taro" }]);
  });
});

describe("POST /users/:userId/revoke-sessions", () => {
  it("CSRF が通れば actorUserId 付きで呼び、件数つきで PRG する", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/revoke-sessions`, {
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

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/users?notice=revoked&revoked=1");
    expect(calls.revokeUserSessions).toEqual([{ actorUserId: SUB, userId: "usr_taro" }]);
  });
});
