import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RpcErrorCode, rpcErr, rpcOk } from "@u18/contracts";
import type {
  AdminCardViewDelegated,
  AuditLogEntryAdmin,
  DeleteUserDelegatedInput,
  DisableCardDelegatedInput,
  GetUserDelegatedInput,
  IdentityAdminDelegatedRpcContract,
  ListAuditLogsDelegatedInput,
  ListCardsByOwnerDelegatedInput,
  ListUsersDelegatedInput,
  ListUsersDelegatedResult,
  NfcAdminDelegatedRpcContract,
  ReinstateUserDelegatedInput,
  RevokeUserSessionsDelegatedInput,
  SuspendUserDelegatedInput,
  UserAdminSummary,
} from "@u18/contracts";
import { PERMISSION_BITS } from "../src/domain/permissions";
import { createApp } from "../src/presentation/http/app";
import { KIWA_STYLESHEET_PATH } from "../src/presentation/http/ui/asset-paths";
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

function auditEntry(overrides: Partial<AuditLogEntryAdmin> = {}): AuditLogEntryAdmin {
  return {
    id: "aud_0001",
    event: "session.started",
    userId: "usr_0001",
    actor: "admin-worker",
    outcome: "success",
    reason: null,
    metadata: null,
    ipHash: null,
    userAgent: null,
    createdAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

function card(overrides: Partial<AdminCardViewDelegated> = {}): AdminCardViewDelegated {
  return {
    cardId: "nfc_0001",
    status: "active",
    ownerUserId: "usr_0001",
    targetUrl: "https://example.com/taro",
    batch: "lot-a",
    issuedAt: "2026-10-01T00:00:00.000Z",
    claimedAt: "2026-10-02T00:00:00.000Z",
    disabledAt: null,
    ...overrides,
  };
}

/**
 * 詳細ページが呼ぶぶんだけ答える nfc-worker の fake（#455）。
 *
 * **一覧（`/users`）は 1 本も呼ばない。** 呼ばれたら落ちるようにして
 * おくと、「一覧がカードまで引き始めた」ことに気づける。
 */
function fakeNfcCards(overrides: Partial<NfcAdminDelegatedRpcContract> = {}): {
  readonly rpc: NfcAdminDelegatedRpcContract;
  readonly calls: { listCardsByOwner: ListCardsByOwnerDelegatedInput[] };
} {
  const calls = { listCardsByOwner: [] as ListCardsByOwnerDelegatedInput[] };
  const unused = (name: string) => () => {
    throw new Error(`${name} は呼ばれない想定のテストで呼ばれた`);
  };

  const rpc: NfcAdminDelegatedRpcContract = {
    disableCard: unused("disableCard"),
    updateCardTarget: unused("updateCardTarget"),
    releaseCard: unused("releaseCard"),
    reinstateCard: unused("reinstateCard"),
    reinstateCardToIssued: unused("reinstateCardToIssued"),
    countBatchIssuedCards: unused("countBatchIssuedCards"),
    batchDisableCards: unused("batchDisableCards"),
    countDisabledInBatch: unused("countDisabledInBatch"),
    reinstateBatchToIssuedCards: unused("reinstateBatchToIssuedCards"),
    listAllCards: unused("listAllCards"),
    countCards: unused("countCards"),
    issueCards: unused("issueCards"),
    getCard: unused("getCard"),
    cardTapHistory: unused("cardTapHistory"),
    tapTimeseries: unused("tapTimeseries"),
    usageFunnel: unused("usageFunnel"),
    batchAnalytics: unused("batchAnalytics"),
    cardUsageRanking: unused("cardUsageRanking"),
    disabledReasonBreakdown: unused("disabledReasonBreakdown"),
    transferCountDistribution: unused("transferCountDistribution"),
    listCardsByOwner: async (input) => {
      calls.listCardsByOwner.push(input);
      return rpcOk({ cards: [card()] });
    },
    ...overrides,
  };

  return { rpc, calls };
}

function fakeIdentityAdmin(overrides: Partial<IdentityAdminDelegatedRpcContract> = {}): {
  readonly rpc: IdentityAdminDelegatedRpcContract;
  readonly calls: {
    listUsers: ListUsersDelegatedInput[];
    getUser: GetUserDelegatedInput[];
    listAuditLogs: ListAuditLogsDelegatedInput[];
    suspendUser: SuspendUserDelegatedInput[];
    reinstateUser: ReinstateUserDelegatedInput[];
    revokeUserSessions: RevokeUserSessionsDelegatedInput[];
    deleteUser: DeleteUserDelegatedInput[];
  };
} {
  const calls = {
    listUsers: [] as ListUsersDelegatedInput[],
    getUser: [] as GetUserDelegatedInput[],
    listAuditLogs: [] as ListAuditLogsDelegatedInput[],
    suspendUser: [] as SuspendUserDelegatedInput[],
    reinstateUser: [] as ReinstateUserDelegatedInput[],
    revokeUserSessions: [] as RevokeUserSessionsDelegatedInput[],
    deleteUser: [] as DeleteUserDelegatedInput[],
  };

  const rpc: IdentityAdminDelegatedRpcContract = {
    listUsers: async (input): Promise<ListUsersDelegatedResult> => {
      calls.listUsers.push(input);
      return rpcOk({ users: [user()], nextCursor: null });
    },
    getUser: async (input) => {
      calls.getUser.push(input);
      return rpcOk(user({ id: input.userId }));
    },
    getUsersByIds: async () => rpcOk([]),
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
    deleteUser: async (input) => {
      calls.deleteUser.push(input);
      return rpcOk({});
    },
    listOAuthClients: async () => rpcOk([]),
    getOAuthClient: async () => rpcErr(RpcErrorCode.Internal, "unused"),
    countOAuthClients: async () => rpcOk(0),
    countUsers: async () => rpcOk({ active: 0, suspended: 0, deleted: 0 }),
    createOAuthClient: async () => rpcErr(RpcErrorCode.Internal, "unused"),
    disableOAuthClient: async () => rpcErr(RpcErrorCode.Internal, "unused"),
    setOAuthClientOwner: async () => rpcErr(RpcErrorCode.Internal, "unused"),
    setOAuthClientAppUrl: async () => rpcErr(RpcErrorCode.Internal, "unused"),
    listAuditLogs: async (input) => {
      calls.listAuditLogs.push(input);
      return rpcOk({ entries: [auditEntry()], nextCursor: null });
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

  /**
   * ボタンの variant だけ直した PR（issue #535）で form の契約まで
   * 壊していないかを見る。既存のテストは直接 POST を組むので、描いた
   * HTML の `name=` と実際に一致しているかはここでしか見ていない。
   */
  it("探すフォームと続きを読むフォームの action / method / name / CSRF が変わっていない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      listUsers: async () => rpcOk({ users: [user({ id: "usr_taro" })], nextCursor: "cursor_abc" }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/users`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const html = await response.text();

    expect(html).toContain('<form method="post" action="/users/search"');
    expect(html).toMatch(/name="csrf_token"/);
    expect(html).toContain('name="query"');

    // 「続きを読む」フォーム（nextCursor が有る時だけ出る）。
    expect(html).toContain('name="cursor" value="cursor_abc"');
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

  /**
   * **行内の操作フォーム 3 種を一覧から外した**（#489、`/nfc` を #481・
   * `/clients` を #508 で外したのと同じ形）。詳細（`/users/:userId`）へ
   * 寄せたので、一覧の行自体はこれらの action を一切持たない——`status`
   * に関わらず。
   */
  it("行内の停止・解除・端末失効フォームを一覧から外した（#489）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      listUsers: async () =>
        rpcOk({
          users: [
            user({ id: "usr_active", status: "active" }),
            user({ id: "usr_suspended", status: "suspended" }),
          ],
          nextCursor: null,
        }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/users`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).not.toContain('action="/users/usr_active/suspend"');
    expect(html).not.toContain('action="/users/usr_active/reinstate"');
    expect(html).not.toContain('action="/users/usr_active/revoke-sessions"');
    expect(html).not.toContain('action="/users/usr_suspended/suspend"');
    expect(html).not.toContain('action="/users/usr_suspended/reinstate"');
    expect(html).not.toContain('action="/users/usr_suspended/revoke-sessions"');
    expect(html).not.toContain('name="reason"');
    // **代わりに、表示名が詳細へのリンクになっている。**
    expect(html).toContain('href="/users/usr_active"');
    expect(html).toContain('href="/users/usr_suspended"');
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
    const html = await response.text();
    expect(html).toContain(`<link rel="stylesheet" href="${KIWA_STYLESHEET_PATH}"/>`);
    expect(html).toContain('href="/users"');
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

/**
 * 利用者の行を物理的に削除する（運用者判断、2026-11-08）。
 *
 * **`IdentityAdminDelegatedRPC` の契約そのものは見ない**（ファイル冒頭と
 * 同じ方針）。ここで見るのは HTTP 層の責務——CSRF・`USER_DELETE` の
 * ガード・2 段階確認・`admin_approvals` との連携・自分自身の扱い。
 */
describe("POST /users/:userId/delete", () => {
  it("CSRF トークンが無ければ 403 で、deleteUser を呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/delete`, {
        method: "POST",
        headers: { Cookie: sessionCookie, Origin: ORIGIN },
        body: new URLSearchParams(),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.deleteUser).toHaveLength(0);
  });

  it("USER_DELETE を持たなければ 403 で、deleteUser を呼ばない", async () => {
    // **`USER_SUSPEND` だけ持っていても通らない。** 専用ビットを使う理由
    // そのものを固定する（`permissions.ts` の `USER_DELETE` の JSDoc）。
    const approvals = fakeApprovals([SUB], [], { [SUB]: PERMISSION_BITS.USER_SUSPEND });
    const sessionCookie = await loginAs(SUB, approvals);
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals, identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/delete`, {
        method: "POST",
        headers: { Cookie: sessionCookie, Origin: ORIGIN },
        body: new URLSearchParams({ confirm: "true" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.deleteUser).toHaveLength(0);
  });

  it("confirm が無ければ deleteUser を呼ばず、確認カードを返す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/delete`, {
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
    expect(calls.deleteUser).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("この操作は取り消せません");
    expect(html).toMatch(/<button[^>]*bg-destructive[^>]*>\s*本当に削除する/);
    expect(html).toMatch(/<a[^>]*href="\/users\/usr_taro"[^>]*>\s*キャンセル/);
  });

  it("confirm=true で呼べば actorUserId・userId 付きで deleteUser を呼び、一覧へ PRG する", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ confirm: "true", csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/delete`, {
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
    expect(response.headers.get("Location")).toBe("/users?notice=deleted");
    expect(calls.deleteUser).toEqual([{ actorUserId: SUB, userId: "usr_taro" }]);
  });

  it("conflict（自分自身）なら理由を言って詳細を描き直す（303 では戻さない）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
      deleteUser: async () => rpcErr(RpcErrorCode.Conflict, "cannot delete yourself"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ confirm: "true", csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/delete`, {
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
    expect(html).toContain("削除できませんでした");
  });

  it("not_found なら理由を言って詳細を描き直す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
      deleteUser: async () => rpcErr(RpcErrorCode.NotFound, "user does not exist"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ confirm: "true", csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/delete`, {
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
    expect(html).toContain("すでに削除されているか");
  });

  it("対象が admin_approvals にも乗っていれば、削除の成功後にその行を消す", async () => {
    const approvals = fakeApprovals([SUB, "usr_taro"]);
    const sessionCookie = await loginAs(SUB, approvals);
    const { rpc, calls } = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
    });
    const app = createApp({ approvals, identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ confirm: "true", csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/delete`, {
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
    expect(calls.deleteUser).toEqual([{ actorUserId: SUB, userId: "usr_taro" }]);
    expect(await approvals.getBySub("usr_taro")).toBeNull();
    expect(approvals.events.at(-1)).toMatchObject({
      event: "ops.approval.revoked",
      sub: "usr_taro",
      actor: SUB,
      reason: "user_deleted",
    });
  });

  it("active な利用者は route 側でも止める（画面の非表示に頼らない、直接 POST を想定）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "active" })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    // **確認済みのふりをして直接叩いても止まる。** 画面はボタン自体を
    // 出していないが、この route は `userId` さえ分かれば直接 POST できる。
    const body = new URLSearchParams({ confirm: "true", csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/delete`, {
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
    expect(calls.deleteUser).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("削除するには先に凍結してください");
  });

  it("suspended・理由が abuse(BAN)なら、確認カードに BAN 無効化の警告を出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
      listAuditLogs: async (input) => {
        if (input.event === "ops.user.suspended") {
          return rpcOk({
            entries: [auditEntry({ event: "ops.user.suspended", metadata: { reason: "abuse" } })],
            nextCursor: null,
          });
        }
        return rpcOk({ entries: [], nextCursor: null });
      },
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/delete`, {
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

    const html = await response.text();
    expect(html).toContain("規約違反による停止(BAN)の意味が失われます");
    expect(html).not.toContain("侵害の疑いによる緊急停止の意味が失われます");
    expect(html).not.toContain("停止の理由を確かめられませんでした");
  });

  it("suspended・理由が compromise(侵害)なら、確認カードに復旧手段喪失の警告を出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
      listAuditLogs: async (input) => {
        if (input.event === "ops.user.suspended") {
          return rpcOk({
            entries: [
              auditEntry({ event: "ops.user.suspended", metadata: { reason: "compromise" } }),
            ],
            nextCursor: null,
          });
        }
        return rpcOk({ entries: [], nextCursor: null });
      },
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/delete`, {
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

    const html = await response.text();
    expect(html).toContain("侵害の疑いによる緊急停止の意味が失われます");
    expect(html).not.toContain("規約違反による停止(BAN)の意味が失われます");
  });

  it("suspended・理由が記録から読めなければ、BAN・侵害の両方を併記する", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
      listAuditLogs: async () => rpcOk({ entries: [], nextCursor: null }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/delete`, {
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

    const html = await response.text();
    expect(html).toContain("停止の理由を確かめられませんでした");
  });

  it("deleted（個人情報 purge 済み）には、BAN／侵害の警告を出さない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "deleted" })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/delete`, {
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
    expect(calls.deleteUser).toHaveLength(0);
    const html = await response.text();
    // deleted でも削除できる(凍結の代わりに purge 済みであればよい)。
    expect(html).toContain("この操作は取り消せません");
    expect(html).not.toContain("規約違反による停止(BAN)の意味が失われます");
    expect(html).not.toContain("侵害の疑いによる緊急停止の意味が失われます");
    expect(html).not.toContain("停止の理由を確かめられませんでした");
  });

  it("最後の super approver を対象にすると、締め出し判定で止まり deleteUser を呼ばない（確認カードも出さない）", async () => {
    // **1 段階目（confirm 無し）でも止まる。** 締め出し判定を確認画面より
    // 先に呼ぶ（指摘: 3b）——「削除できる」と見せてから 2 段階目で拒否する
    // のは行き止まりになる。
    const approvals = fakeApprovals([SUB, "usr_taro"], ["usr_taro"]);
    const sessionCookie = await loginAs(SUB, approvals);
    const { rpc, calls } = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
    });
    const app = createApp({ approvals, identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/delete`, {
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
    expect(calls.deleteUser).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("最後の super approver");
    // 締め出し判定で止まったので、確認カード（本当に削除する）は出ていない。
    expect(html).not.toContain("本当に削除する");
    expect(await approvals.getBySub("usr_taro")).not.toBeNull();
  });
});

/**
 * 利用者 1 人の詳細（`/users/:userId`、#455）。
 *
 * **見たいのは HTTP 層の責務だけ**（ファイル冒頭と同じ方針）——
 * どの RPC をどう呼び分けたか、塊が欠けたときに何が残るか、
 * `suspended` の理由をどう言い分けるか。
 */
describe("GET /users/:userId", () => {
  function appWith(
    identityAdmin: IdentityAdminDelegatedRpcContract,
    nfcCards: NfcAdminDelegatedRpcContract,
  ) {
    return createApp({ approvals: fakeApprovals([SUB]), identityAdmin, nfcCards });
  }

  async function openDetail(
    identityAdmin: IdentityAdminDelegatedRpcContract,
    nfcCards: NfcAdminDelegatedRpcContract,
    userId = "usr_taro",
  ): Promise<Response> {
    const sessionCookie = await loginAsApproved();
    return appWith(identityAdmin, nfcCards).fetch(
      new Request(`${ORIGIN}/users/${userId}`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
  }

  it("要約・カード・監査ログを 1 枚に出し、一覧を引かない", async () => {
    const identity = fakeIdentityAdmin();
    const nfc = fakeNfcCards();

    const response = await openDetail(identity.rpc, nfc.rpc);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("usr_taro");
    expect(html).toContain("taro@example.com");
    expect(html).toContain("nfc_0001");
    expect(html).toContain("session.started");
    // **`listUsers` を引いて 1 件に絞らない**（契約の `getUser` の冒頭）。
    expect(identity.calls.listUsers).toHaveLength(0);
    expect(identity.calls.getUser).toEqual([{ actorUserId: SUB, userId: "usr_taro" }]);
    expect(nfc.calls.listCardsByOwner).toEqual([{ actorUserId: SUB, ownerUserId: "usr_taro" }]);
  });

  /**
   * ボタンの variant だけ直した PR（issue #535）で form の契約まで
   * 壊していないかを見る。既存のテストは直接 POST を組むので、描いた
   * HTML の `name=`/`action=` と実際に一致しているかはここでしか見ていない。
   */
  it("有効な利用者の停止・端末失効フォームの action / method / name / CSRF が変わっていない", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "active" })),
    });

    const response = await openDetail(identity.rpc, fakeNfcCards().rpc);
    const html = await response.text();

    expect(html).toContain('<form method="post" action="/users/usr_taro/suspend">');
    expect(html).toContain('name="from" value="detail"');
    expect(html).toContain('name="reason" value="compromise"');
    expect(html).toContain('name="reason" value="abuse"');

    expect(html).toContain('<form method="post" action="/users/usr_taro/revoke-sessions">');

    // 2 つの form が別々に CSRF トークンを持つ。
    expect([...html.matchAll(/name="csrf_token"/g)]).toHaveLength(
      [...html.matchAll(/<form method="post"/g)].length,
    );
  });

  it("運営による停止中の利用者は、解除フォームの action / method / CSRF が変わっていない", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
      listAuditLogs: async (input) => {
        if (input.event === "ops.user.suspended") {
          return rpcOk({
            entries: [
              auditEntry({
                event: "ops.user.suspended",
                createdAt: "2026-11-01T00:00:00.000Z",
                metadata: { reason: "compromise" },
              }),
            ],
            nextCursor: null,
          });
        }
        return rpcOk({ entries: [], nextCursor: null });
      },
    });

    const response = await openDetail(identity.rpc, fakeNfcCards().rpc);
    const html = await response.text();

    expect(html).toContain('<form method="post" action="/users/usr_taro/reinstate">');
    expect(html).toContain('name="from" value="detail"');
    expect(html).toContain("停止を解除する");
  });

  it("監査ログの実行者（metadata.actorUserId）を名前で出す（#482）", async () => {
    // **`entry.userId` ではない。** このクエリは `userId` で絞り込んで
    // いるので、`entry.userId` は常にこの利用者自身（対象）になる——
    // 実行者は `metadata.actorUserId`（`DelegatedManageUserUseCase` の
    // JSDoc を参照）。
    const identity = fakeIdentityAdmin({
      listAuditLogs: async () =>
        rpcOk({
          entries: [
            auditEntry({
              event: "ops.user.suspended",
              metadata: { reason: "compromise", revokedSessions: 2, actorUserId: "usr_admin" },
            }),
          ],
          nextCursor: null,
        }),
      getUsersByIds: async () =>
        rpcOk([{ id: "usr_admin", username: "admin", displayName: "管理者", status: "active" }]),
    });

    const response = await openDetail(identity.rpc, fakeNfcCards().rpc);

    const html = await response.text();
    expect(html).toContain("管理者 (@admin)");
    expect(html).toContain('href="/users/usr_admin"');
    // **対象（この利用者自身）の生の ID は「実行者」列に出ない。**
    expect(html).not.toContain("usr_taro (@");
  });

  it("タップ回数を出さない（#394 / #454）", async () => {
    const response = await openDetail(fakeIdentityAdmin().rpc, fakeNfcCards().rpc);

    const html = await response.text();
    expect(html).not.toContain("タップ回数");
    expect(html).toContain("誰が使ったかを記録しない設計のため出していません");
  });

  it("埋め込みの監査ログの metadata JSON にコピー用の目印（data-copy）を付ける（#488）", async () => {
    const identity = fakeIdentityAdmin({
      listAuditLogs: async () =>
        rpcOk({
          entries: [auditEntry({ metadata: { reason: "compromise", revokedSessions: 2 } })],
          nextCursor: null,
        }),
    });
    const response = await openDetail(identity.rpc, fakeNfcCards().rpc);

    const html = await response.text();
    expect(html).toContain(
      'data-copy="{&quot;reason&quot;:&quot;compromise&quot;,&quot;revokedSessions&quot;:2}" hidden',
    );
  });

  it("カード ID 自体がカード詳細へのリンクで、コピーボタンも持つ（#488）", async () => {
    const response = await openDetail(fakeIdentityAdmin().rpc, fakeNfcCards().rpc);

    const html = await response.text();
    // **#490 で直ったリンク先**（一覧内アンカーではなくカード詳細）。
    // `/nfc#card-` へ巻き戻っていないことも合わせて見る。
    expect(html).toContain('href="/nfc/nfc_0001"');
    expect(html).not.toContain("/nfc#card-");
    expect(html).toContain('data-copy="nfc_0001"');
    // 旧・別列の「カードの詳細へ」リンクは消えている（ID 自体がリンクに
    // なったので重複する導線を残さない）。
    expect(html).not.toContain("カードの詳細へ");
  });

  it("利用者 ID にコピーボタンを持つ（#488）", async () => {
    const response = await openDetail(fakeIdentityAdmin().rpc, fakeNfcCards().rpc);

    const html = await response.text();
    expect(html).toContain('data-copy="usr_taro"');
  });

  it("存在しない userId は 404 で、一覧へ戻る導線を持つ", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async () => rpcErr(RpcErrorCode.NotFound, "no such user"),
    });

    const response = await openDetail(identity.rpc, fakeNfcCards().rpc, "usr_missing");

    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("見つかりません");
    expect(html).toContain('href="/users"');
  });

  it("getUser が not_found 以外で落ちたら 503（「見つかりません」と混ぜない）", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async () => rpcErr(RpcErrorCode.Internal, "boom"),
    });

    const response = await openDetail(identity.rpc, fakeNfcCards().rpc);

    expect(response.status).toBe(503);
  });

  it("カードが取れなくても、本人の要約と監査ログは出す", async () => {
    // **`Promise.all` だとここで全体が落ちる。** reject する fake を
    // 置いているのはそのため（`app.tsx` の `/` と同じ形）。
    const nfc = fakeNfcCards({
      listCardsByOwner: async () => {
        throw new Error("service binding down");
      },
    });

    const response = await openDetail(fakeIdentityAdmin().rpc, nfc.rpc);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("いまカードの一覧を取得できません");
    expect(html).toContain("taro@example.com");
    expect(html).toContain("session.started");
  });

  it("監査ログが取れなくても、本人の要約とカードは出す", async () => {
    const identity = fakeIdentityAdmin({
      listAuditLogs: async () => rpcErr(RpcErrorCode.Internal, "boom"),
    });

    const response = await openDetail(identity.rpc, fakeNfcCards().rpc);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("いま監査ログを取得できません");
    expect(html).toContain("nfc_0001");
  });

  it("active の利用者には停止の理由を引かない", async () => {
    const identity = fakeIdentityAdmin();

    await openDetail(identity.rpc, fakeNfcCards().rpc);

    // 直近の一覧 1 本だけ。イベント名での絞り込みは走らない。
    expect(identity.calls.listAuditLogs).toHaveLength(1);
    expect(identity.calls.listAuditLogs[0]?.event).toBeUndefined();
  });

  it("退会による停止は「本人が退会」と言い、解除のボタンの文言を変える", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
      listAuditLogs: async (input) => {
        if (input.event === "ops.user.suspended") {
          return rpcOk({
            entries: [
              auditEntry({
                event: "ops.user.suspended",
                createdAt: "2026-10-01T00:00:00.000Z",
                metadata: { reason: "abuse" },
              }),
            ],
            nextCursor: null,
          });
        }
        if (input.event === "account.closed") {
          // **こちらのほうが新しい。** 一度凍結されて解除された人が、
          // 後から自分で退会した形。
          return rpcOk({
            entries: [
              auditEntry({ event: "account.closed", createdAt: "2026-11-01T00:00:00.000Z" }),
            ],
            nextCursor: null,
          });
        }
        return rpcOk({ entries: [], nextCursor: null });
      },
    });

    const response = await openDetail(identity.rpc, fakeNfcCards().rpc);

    const html = await response.text();
    expect(html).toContain("本人が退会した結果の停止です");
    expect(html).toContain("それでも停止を解除する");
    expect(html).not.toContain("運営が停止しました");
  });

  it("運営による停止は理由まで言う", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
      listAuditLogs: async (input) => {
        if (input.event === "ops.user.suspended") {
          return rpcOk({
            entries: [
              auditEntry({
                event: "ops.user.suspended",
                createdAt: "2026-11-01T00:00:00.000Z",
                metadata: { reason: "compromise" },
              }),
            ],
            nextCursor: null,
          });
        }
        return rpcOk({ entries: [], nextCursor: null });
      },
    });

    const response = await openDetail(identity.rpc, fakeNfcCards().rpc);

    const html = await response.text();
    expect(html).toContain("運営が停止しました");
    expect(html).toContain("侵害の疑い");
    expect(html).not.toContain("それでも停止を解除する");
  });

  it("どちらの記録も無ければ断定しない", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
      listAuditLogs: async () => rpcOk({ entries: [], nextCursor: null }),
    });

    const response = await openDetail(identity.rpc, fakeNfcCards().rpc);

    const html = await response.text();
    expect(html).toContain("どちらの理由による停止か分かりませんでした");
  });

  it("監査ログを引けなければ「確かめられない」と言う（記録が無いと混ぜない）", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
      listAuditLogs: async () => rpcErr(RpcErrorCode.Internal, "boom"),
    });

    const response = await openDetail(identity.rpc, fakeNfcCards().rpc);

    const html = await response.text();
    expect(html).toContain("理由を確かめられません");
    expect(html).not.toContain("どちらの理由による停止か分かりませんでした");
  });

  it("自分の行には停止を出さない（押せるのに断られる形にしない）", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId })),
    });

    const response = await openDetail(identity.rpc, fakeNfcCards().rpc, SUB);

    const html = await response.text();
    expect(html).toContain("自分のアカウントは停止できません");
  });

  it("自分の行には削除ボタンを出さない（運用者判断、2026-11-08。指摘: 3b）", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId })),
    });

    const response = await openDetail(identity.rpc, fakeNfcCards().rpc, SUB);

    const html = await response.text();
    expect(html).toContain("自分のアカウントは削除できません");
    expect(html).not.toContain(`action="/users/${SUB}/delete"`);
  });

  it("active な利用者には削除ボタンを出さず、先に凍結するよう案内する（2026-11-08 追加決定）", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "active" })),
    });

    const response = await openDetail(identity.rpc, fakeNfcCards().rpc);

    const html = await response.text();
    expect(html).toContain("削除するには先に凍結してください");
    expect(html).not.toContain('action="/users/usr_taro/delete"');
  });

  it("suspended（BAN／侵害停止どちらもありうる）の利用者には、削除ボタンを出す", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
    });

    const response = await openDetail(identity.rpc, fakeNfcCards().rpc);

    const html = await response.text();
    // active と違って、凍結中は削除ボタン自体が出る。警告文の出し分け
    // そのものは確認カードが出る POST 側のテストで見る。
    expect(html).toContain('action="/users/usr_taro/delete"');
  });
});

describe("POST /users/:userId/disable-cards（#486）", () => {
  async function csrfContext(
    identityAdmin: IdentityAdminDelegatedRpcContract,
    nfcCards: NfcAdminDelegatedRpcContract,
  ): Promise<{ readonly app: ReturnType<typeof createApp>; readonly cookie: string }> {
    const sessionCookie = await loginAsApproved();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin, nfcCards });
    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    return { app, cookie: `${sessionCookie}; ${csrfCookie}` };
  }

  async function post(
    app: ReturnType<typeof createApp>,
    cookie: string,
    body: URLSearchParams,
  ): Promise<Response> {
    return app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/disable-cards`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: ORIGIN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      }),
      env,
      executionContext(),
    );
  }

  async function getDetail(
    identityAdmin: IdentityAdminDelegatedRpcContract,
    nfcCards: NfcAdminDelegatedRpcContract,
  ): Promise<Response> {
    const sessionCookie = await loginAsApproved();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin, nfcCards });
    return app.fetch(
      new Request(`${ORIGIN}/users/usr_taro`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
  }

  it("有効な利用者（active）には、カードを止めるボタンを出さない", async () => {
    const identity = fakeIdentityAdmin();
    const response = await getDetail(identity.rpc, fakeNfcCards().rpc);

    const html = await response.text();
    expect(html).not.toContain("この人のカードをまとめて止められます");
    expect(html).not.toContain("対象を確認する");
  });

  it("停止中の利用者には、カードを止めるボタンを出す", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
    });
    const response = await getDetail(identity.rpc, fakeNfcCards().rpc);

    const html = await response.text();
    expect(html).toContain("この人のカードをまとめて止められます");
    // **#528**: 押した瞬間に実行されるように読めないこと。/nfc のバッチ
    // 一括無効化と同じ「対象を確認する」で、2 段階確認だと分かる。
    expect(html).toContain("対象を確認する");
  });

  it("CSRF トークンが無ければ 403 で、disableCard を呼ばない", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
    });
    const { rpc, calls } = fakeNfcCards({ disableCard: async () => rpcOk(null) });
    const sessionCookie = await loginAsApproved();
    const app = createApp({
      approvals: fakeApprovals([SUB]),
      identityAdmin: identity.rpc,
      nfcCards: rpc,
    });

    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/disable-cards`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ confirmed: "1" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.listCardsByOwner).toHaveLength(0);
  });

  it("1 段階目（confirmed 無し）は書き込まず、所持・止められる・既に無効化済みの内訳を出す", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
    });
    const { rpc } = fakeNfcCards({
      listCardsByOwner: async () =>
        rpcOk({
          cards: [
            card({ cardId: "nfc_a", status: "active" }),
            card({ cardId: "nfc_b", status: "issued" }),
            card({ cardId: "nfc_c", status: "disabled" }),
          ],
        }),
      disableCard: () => {
        throw new Error("1 段階目で呼ばれた");
      },
    });
    const { app, cookie } = await csrfContext(identity.rpc, rpc);
    const csrfToken = csrfTokenFrom(cookie);

    const response = await post(app, cookie, new URLSearchParams({ csrf_token: csrfToken }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("所持");
    expect(html).toContain("3 枚");
    expect(html).toContain("2 枚");
    expect(html).toContain("既に無効化済み");
    expect(html).toContain("1 枚");
    expect(html).toContain("本当に 2 枚を無効化する");
  });

  it("所持カードが全部無効化済みなら、1 段階目でエラーにする", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
    });
    const { rpc } = fakeNfcCards({
      listCardsByOwner: async () => rpcOk({ cards: [card({ status: "disabled" })] }),
    });
    const { app, cookie } = await csrfContext(identity.rpc, rpc);
    const csrfToken = csrfTokenFrom(cookie);

    const response = await post(app, cookie, new URLSearchParams({ csrf_token: csrfToken }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("止められるカードがありません");
  });

  it("2 段階目は、1 段階目の内訳をそのまま信用せず、もう一度分類し直す", async () => {
    // **1 段階目を見てから 2 段階目を押すまでの間に状態が変わっても、
    // 2 段階目はそのときのフレッシュな一覧を見る。** `csrfContext` の
    // GET を 1 回目として、1 段階目の POST までは 2 枚とも active——
    // その後、2 段階目を押す前に（本人が自分で手放した、等を想定して）
    // 片方が既に無効化済みになる。
    let postCount = 0;
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
    });
    const { rpc } = fakeNfcCards({
      listCardsByOwner: async () =>
        rpcOk({
          cards: [
            card({ cardId: "nfc_a", status: postCount < 1 ? "active" : "disabled" }),
            card({ cardId: "nfc_b", status: "active" }),
          ],
        }),
      disableCard: async ({ cardId }) => {
        expect(cardId).toBe("nfc_b");
        return rpcOk(null);
      },
    });
    const { app, cookie } = await csrfContext(identity.rpc, rpc);
    const csrfToken = csrfTokenFrom(cookie);

    // 1 段階目: この時点では "nfc_a" もまだ active。
    const confirmResponse = await post(app, cookie, new URLSearchParams({ csrf_token: csrfToken }));
    expect(await confirmResponse.text()).toContain("本当に 2 枚を無効化する");
    postCount += 1;

    // 2 段階目: "nfc_a" が既に無効化済みになっている状態で押す。
    const response = await post(
      app,
      cookie,
      new URLSearchParams({ csrf_token: csrfToken, confirmed: "1" }),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    // **"nfc_a" を巻き込んでいない。** 1 段階目の内訳（2 枚）をそのまま
    // 信用していたら、ここで "nfc_a" にも `disableCard` を呼んでいた。
    expect(html).toContain("1 枚を無効化しました");
  });

  it("2 段階目: disableCard に reason: owner_suspended を渡し、actorUserId は session.sub", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
    });
    const disableCalls: DisableCardDelegatedInput[] = [];
    const { rpc } = fakeNfcCards({
      listCardsByOwner: async () => rpcOk({ cards: [card({ cardId: "nfc_a", status: "active" })] }),
      disableCard: async (input) => {
        disableCalls.push(input);
        return rpcOk(null);
      },
    });
    const { app, cookie } = await csrfContext(identity.rpc, rpc);
    const csrfToken = csrfTokenFrom(cookie);

    await post(app, cookie, new URLSearchParams({ csrf_token: csrfToken, confirmed: "1" }));

    expect(disableCalls).toEqual([
      { actorUserId: SUB, cardId: "nfc_a", reason: "owner_suspended" },
    ]);
  });

  it("失敗理由を not_found とそれ以外で分ける。全部「見つかりませんでした」に畳まない", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
    });
    const { rpc } = fakeNfcCards({
      listCardsByOwner: async () =>
        rpcOk({
          cards: [
            card({ cardId: "nfc_missing", status: "active" }),
            card({ cardId: "nfc_broken", status: "active" }),
          ],
        }),
      disableCard: async ({ cardId }) =>
        cardId === "nfc_missing"
          ? rpcErr(RpcErrorCode.NotFound, "no such card")
          : rpcErr(RpcErrorCode.Internal, "boom"),
    });
    const { app, cookie } = await csrfContext(identity.rpc, rpc);
    const csrfToken = csrfTokenFrom(cookie);

    const response = await post(
      app,
      cookie,
      new URLSearchParams({ csrf_token: csrfToken, confirmed: "1" }),
    );

    const html = await response.text();
    expect(html).toContain("nfc_missing");
    expect(html).toContain("そのカードは見つかりませんでした");
    expect(html).toContain("nfc_broken");
    expect(html).toContain("いま処理できませんでした");
    // **"見つかりませんでした" に畳んでいない**——2 枚とも同じ文言なら、
    // 一時的な障害まで「もう無い」と読める（issue #486 への指摘）。
    expect(html).toContain("nfc_broken</code> — いま処理できませんでした");
    expect(html).not.toContain("nfc_broken</code> — そのカードは見つかりませんでした");
  });

  it("一度に処理するのは上限まで。超えたぶんは次の実行に回す", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
    });
    const manyCards = Array.from({ length: 101 }, (_, i) =>
      card({ cardId: `nfc_${i}`, status: "active" }),
    );
    const { rpc } = fakeNfcCards({
      listCardsByOwner: async () => rpcOk({ cards: manyCards }),
      disableCard: () => {
        throw new Error("1 段階目で呼ばれた");
      },
    });
    const { app, cookie } = await csrfContext(identity.rpc, rpc);
    const csrfToken = csrfTokenFrom(cookie);

    const response = await post(app, cookie, new URLSearchParams({ csrf_token: csrfToken }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("本当に 100 枚を無効化する");
    expect(html).toContain("一度に止められる枚数には上限があります");
  });
});

describe("詳細からの操作（from=detail）", () => {
  async function postFromDetail(
    identityAdmin: IdentityAdminDelegatedRpcContract,
    path: string,
    fields: Record<string, string>,
  ): Promise<Response> {
    const sessionCookie = await loginAsApproved();
    const app = createApp({
      approvals: fakeApprovals([SUB]),
      identityAdmin,
      nfcCards: fakeNfcCards().rpc,
    });
    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    return app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ ...fields, csrf_token: csrfToken, from: "detail" }),
      }),
      env,
      executionContext(),
    );
  }

  it("成功したら詳細へ戻す（一覧ではない）", async () => {
    const identity = fakeIdentityAdmin();

    const response = await postFromDetail(identity.rpc, "/users/usr_taro/suspend", {
      reason: "abuse",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/users/usr_taro?notice=suspended&revoked=2");
  });

  it("失敗したら詳細を描き直す（一覧へ飛ばさない）", async () => {
    const identity = fakeIdentityAdmin({
      reinstateUser: async () => rpcErr(RpcErrorCode.Conflict, "not suspended"),
    });

    const response = await postFromDetail(identity.rpc, "/users/usr_taro/reinstate", {});

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("解除できませんでした");
    // 詳細のままであることを、詳細にしか無い見出しで確かめる。
    expect(html).toContain("持っているカード");
  });

  it("from が無ければ、これまでどおり一覧へ戻る", async () => {
    const sessionCookie = await loginAsApproved();
    const identity = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: identity.rpc });
    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/users`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/users/usr_taro/revoke-sessions`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/users?notice=revoked&revoked=1");
  });
});
