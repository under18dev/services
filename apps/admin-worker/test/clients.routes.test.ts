import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RpcErrorCode, rpcErr, rpcOk } from "@u18/contracts";
import type {
  CreateOAuthClientDelegatedInput,
  CreateOAuthClientDelegatedResult,
  DisableOAuthClientDelegatedInput,
  DisableOAuthClientDelegatedResult,
  IdentityAdminDelegatedRpcContract,
  ListOAuthClientsDelegatedResult,
  OAuthClientSummary,
} from "@u18/contracts";
import { createApp } from "../src/presentation/http/app";
import { ORIGIN, cookieHeaderFrom, executionContext, fakeApprovals, loginAs } from "./helpers";

/**
 * OAuth クライアント管理画面（`/clients`、#390 決定 16 ③ 段取り 3）。
 *
 * **`IdentityAdminDelegatedRPC` 自体はここでは確かめない。** あちらは
 * auth-worker 側の契約テストが持つ。ここで見るのは HTTP 層の責務だけ——
 * CSRF・actorUserId の渡し方・失敗したときの文言・`client_secret` の
 * 出し方（移行元の `admin-clients.test.ts` と同じ観点）。
 */

const SUB = "usr_admin_clients";

function client(overrides: Partial<OAuthClientSummary> = {}): OAuthClientSummary {
  return {
    clientId: "app_0001",
    name: "Sample App",
    clientType: "confidential",
    isFirstParty: false,
    logoUrl: null,
    redirectUris: ["https://example.com/callback"],
    scopes: ["openid", "profile", "email"],
    createdAt: "2026-10-01T00:00:00.000Z",
    disabledAt: null,
    ...overrides,
  };
}

function fakeIdentityAdmin(overrides: Partial<IdentityAdminDelegatedRpcContract> = {}): {
  readonly rpc: IdentityAdminDelegatedRpcContract;
  readonly calls: {
    createOAuthClient: CreateOAuthClientDelegatedInput[];
    disableOAuthClient: DisableOAuthClientDelegatedInput[];
  };
} {
  const calls = {
    createOAuthClient: [] as CreateOAuthClientDelegatedInput[],
    disableOAuthClient: [] as DisableOAuthClientDelegatedInput[],
  };

  const rpc: IdentityAdminDelegatedRpcContract = {
    listUsers: async () => rpcOk({ users: [], nextCursor: null }),
    suspendUser: async () => rpcOk({ revokedSessions: 0 }),
    reinstateUser: async () => rpcOk({}),
    revokeUserSessions: async () => rpcOk({ revokedSessions: 0 }),
    listOAuthClients: async (): Promise<ListOAuthClientsDelegatedResult> => rpcOk([client()]),
    createOAuthClient: async (input): Promise<CreateOAuthClientDelegatedResult> => {
      calls.createOAuthClient.push(input);
      return rpcOk({
        client: client({ clientId: "app_0002", name: input.name }),
        clientSecret: "s3cr3t",
      });
    },
    disableOAuthClient: async (input): Promise<DisableOAuthClientDelegatedResult> => {
      calls.disableOAuthClient.push(input);
      return rpcOk({ disabled: true });
    },
    listAuditLogs: async () => rpcOk({ entries: [], nextCursor: null }),
    ...overrides,
  };

  return { rpc, calls };
}

async function loginAsApproved(): Promise<string> {
  const approvals = fakeApprovals([SUB]);
  return loginAs(SUB, approvals);
}

/** `ensureCsrfToken` が立てた Cookie から、トークンの値だけを取り出す。 */
function csrfTokenFrom(cookieHeader: string): string {
  const match = /u18_csrf=([^;]+)/.exec(cookieHeader);
  if (match === null) throw new Error("csrf cookie not found");
  return decodeURIComponent(match[1]!);
}

describe("GET /clients", () => {
  it("一覧と CSRF トークンを描く", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      listOAuthClients: async () =>
        rpcOk([
          client({ clientId: "app_a", name: "App A" }),
          client({ clientId: "app_b", name: "App B", isFirstParty: true }),
        ]),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("App A");
    expect(html).toContain("App B");
    expect(html).toContain("u18 公式");
    // 一次パーティには失効フォームが無い。
    expect(html).not.toMatch(/name="client_id" value="app_b"/);
    expect(html).toMatch(/name="csrf_token"/);
  });

  it("listOAuthClients が失敗したら 503", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      listOAuthClients: async () => rpcErr(RpcErrorCode.Internal, "boom"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(503);
  });
});

describe("POST /clients（登録）", () => {
  it("CSRF トークンが無ければ 403 で、createOAuthClient を呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const body = new URLSearchParams({
      name: "App",
      client_type: "confidential",
      redirect_uris: "https://example.com/callback",
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/clients`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.createOAuthClient).toHaveLength(0);
  });

  it("種別を選んでいなければ RPC を呼ばず、やり直せる文言を出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrf_token = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({
      name: "App",
      redirect_uris: "https://example.com/callback",
      csrf_token,
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/clients`, {
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
    expect(calls.createOAuthClient).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("種別を選んでください。");
  });

  it("CSRF が通れば createOAuthClient を actorUserId 付きで呼び、200 でそのまま描く（PRG を挟まない）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrf_token = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({
      name: "My App",
      client_type: "confidential",
      redirect_uris: "https://example.com/callback\nhttps://example.com/other",
      scopes: "openid profile",
      logo_url: "https://example.com/logo.png",
      csrf_token,
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/clients`, {
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

    // **PRG を挟まない。** client_secret はこの応答にしか無い。
    expect(response.status).toBe(200);
    expect(calls.createOAuthClient).toEqual([
      {
        actorUserId: SUB,
        name: "My App",
        clientType: "confidential",
        redirectUris: ["https://example.com/callback", "https://example.com/other"],
        scopes: ["openid", "profile"],
        logoUrl: "https://example.com/logo.png",
      },
    ]);
    const html = await response.text();
    expect(html).toContain("s3cr3t");
    expect(html).toContain("を登録しました");
  });

  it("scope・ロゴ URL を省略すると渡さない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrf_token = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({
      name: "My App",
      client_type: "public",
      redirect_uris: "https://example.com/callback",
      csrf_token,
    });
    await app.fetch(
      new Request(`${ORIGIN}/clients`, {
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

    expect(calls.createOAuthClient).toEqual([
      {
        actorUserId: SUB,
        name: "My App",
        clientType: "public",
        redirectUris: ["https://example.com/callback"],
      },
    ]);
  });

  it("public クライアントは client_secret の枠を出さない（空欄を出さない）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      createOAuthClient: async (input) =>
        rpcOk({ client: client({ clientId: "app_pub", name: input.name }), clientSecret: null }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrf_token = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({
      name: "SPA",
      client_type: "public",
      redirect_uris: "https://example.com/callback",
      csrf_token,
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/clients`, {
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
    expect(html).toContain("public クライアントなので client_secret はありません");
    expect(html).not.toMatch(/type="text"[^>]*readonly/);
  });

  it("invalid_input を一般的な入力確認の文言にする（内部の理由は出さない）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      createOAuthClient: async () =>
        rpcErr(RpcErrorCode.InvalidInput, "redirect_uri is not registrable (not_https)"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrf_token = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({
      name: "App",
      client_type: "confidential",
      redirect_uris: "http://example.com/callback",
      csrf_token,
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/clients`, {
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
    expect(html).not.toContain("not_registrable");
    expect(html).not.toContain("not_https");
    expect(html).toContain("入力に問題があります。");
  });

  it("client_id の重複（conflict）を言い直す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      createOAuthClient: async () =>
        rpcErr(RpcErrorCode.Conflict, "client_id is already registered"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrf_token = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({
      name: "App",
      client_type: "confidential",
      redirect_uris: "https://example.com/callback",
      csrf_token,
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/clients`, {
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
    expect(html).toContain("既に使われています");
  });
});

describe("POST /clients/disable", () => {
  it("CSRF トークンが無ければ 403 で、disableOAuthClient を呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/disable`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "app_0001" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.disableOAuthClient).toHaveLength(0);
  });

  it("CSRF が通れば disableOAuthClient を actorUserId 付きで呼ぶ", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrf_token = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/disable`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ client_id: "app_0001", csrf_token }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(calls.disableOAuthClient).toEqual([{ actorUserId: SUB, clientId: "app_0001" }]);
    const html = await response.text();
    expect(html).toContain("失効させました");
  });

  /**
   * **一次パーティは失効させられない**（#331 の判断。管理者 1 人で
   * `u18-dashboard` を失効させて全サービスのログインを落とせた件）。
   * ここでは delegated UseCase 側が `conflict` を返す前提で、移した側
   * （admin-worker）がその文言をちゃんと表に出すことだけを確かめる。
   */
  it("一次パーティの失効は conflict として拒まれ、理由を表示する", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      disableOAuthClient: async () =>
        rpcErr(
          RpcErrorCode.Conflict,
          "first-party clients can only be disabled with scripts/oauth-client.mjs",
        ),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrf_token = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/disable`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ client_id: "app_dashboard", csrf_token }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("u18 公式のクライアントは、この画面からは失効させられません。");
  });

  it("既に失効済み（冪等）なら言い切らない文言にする", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      disableOAuthClient: async () => rpcOk({ disabled: false }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrf_token = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/disable`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ client_id: "app_unknown", csrf_token }),
      }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("既に失効しています");
  });
});

describe("未ログイン・未承認", () => {
  it("未ログインは /login へ送る", async () => {
    const app = createApp({ approvals: fakeApprovals([]) });

    const response = await app.fetch(new Request(`${ORIGIN}/clients`), env, executionContext());

    expect(response.status).toBe(302);
    expect(response.headers.get("Location") ?? "").toContain("/login?return_to=");
  });

  it("未承認は /pending へ送る", async () => {
    const approvals = fakeApprovals([]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/pending");
  });
});
