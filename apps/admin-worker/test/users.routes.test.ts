import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RpcErrorCode, rpcErr, rpcOk } from "@u18/contracts";
import type {
  AdminCardViewDelegated,
  AuditLogEntryAdmin,
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
  };
} {
  const calls = {
    listUsers: [] as ListUsersDelegatedInput[],
    getUser: [] as GetUserDelegatedInput[],
    listAuditLogs: [] as ListAuditLogsDelegatedInput[],
    suspendUser: [] as SuspendUserDelegatedInput[],
    reinstateUser: [] as ReinstateUserDelegatedInput[],
    revokeUserSessions: [] as RevokeUserSessionsDelegatedInput[],
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
    listOAuthClients: async () => rpcOk([]),
    countOAuthClients: async () => rpcOk(0),
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

  it("タップ回数を出さない（#394 / #454）", async () => {
    const response = await openDetail(fakeIdentityAdmin().rpc, fakeNfcCards().rpc);

    const html = await response.text();
    expect(html).not.toContain("タップ回数");
    expect(html).toContain("誰が使ったかを記録しない設計のため出していません");
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
