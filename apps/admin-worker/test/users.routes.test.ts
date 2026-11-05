import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RpcErrorCode, rpcErr, rpcOk } from "@u18/contracts";
import type {
  AdminCardViewDelegated,
  AuditLogEntryAdmin,
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
    getOAuthClient: async () => rpcErr(RpcErrorCode.Internal, "unused"),
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
    expect(html).not.toContain("この人のカードをまとめて止める");
  });

  it("停止中の利用者には、カードを止めるボタンを出す", async () => {
    const identity = fakeIdentityAdmin({
      getUser: async (input) => rpcOk(user({ id: input.userId, status: "suspended" })),
    });
    const response = await getDetail(identity.rpc, fakeNfcCards().rpc);

    const html = await response.text();
    expect(html).toContain("この人のカードをまとめて止める");
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
