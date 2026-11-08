import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RpcErrorCode, rpcErr, rpcOk } from "@u18/contracts";
import type {
  CreateOAuthClientDelegatedInput,
  CreateOAuthClientDelegatedResult,
  DisableOAuthClientDelegatedInput,
  DisableOAuthClientDelegatedResult,
  GetOAuthClientDelegatedResult,
  IdentityAdminDelegatedRpcContract,
  ListOAuthClientsDelegatedResult,
  OAuthClientSummary,
  SetOAuthClientAppUrlDelegatedInput,
  SetOAuthClientAppUrlDelegatedResult,
  SetOAuthClientOwnerDelegatedInput,
  SetOAuthClientOwnerDelegatedResult,
} from "@u18/contracts";
import { createApp } from "../src/presentation/http/app";
import { KIWA_STYLESHEET_PATH } from "../src/presentation/http/ui/asset-paths";
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
    ownerUserId: null,
    appUrl: null,
    ...overrides,
  };
}

function fakeIdentityAdmin(overrides: Partial<IdentityAdminDelegatedRpcContract> = {}): {
  readonly rpc: IdentityAdminDelegatedRpcContract;
  readonly calls: {
    createOAuthClient: CreateOAuthClientDelegatedInput[];
    disableOAuthClient: DisableOAuthClientDelegatedInput[];
    setOAuthClientOwner: SetOAuthClientOwnerDelegatedInput[];
    setOAuthClientAppUrl: SetOAuthClientAppUrlDelegatedInput[];
  };
} {
  const calls = {
    createOAuthClient: [] as CreateOAuthClientDelegatedInput[],
    disableOAuthClient: [] as DisableOAuthClientDelegatedInput[],
    setOAuthClientOwner: [] as SetOAuthClientOwnerDelegatedInput[],
    setOAuthClientAppUrl: [] as SetOAuthClientAppUrlDelegatedInput[],
  };

  const rpc: IdentityAdminDelegatedRpcContract = {
    listUsers: async () => rpcOk({ users: [], nextCursor: null }),
    getUser: async () => rpcErr(RpcErrorCode.Internal, "unused"),
    getUsersByIds: async () => rpcOk([]),
    suspendUser: async () => rpcOk({ revokedSessions: 0 }),
    reinstateUser: async () => rpcOk({}),
    revokeUserSessions: async () => rpcOk({ revokedSessions: 0 }),
    deleteUser: async () => rpcErr(RpcErrorCode.Internal, "unused"),
    listOAuthClients: async (): Promise<ListOAuthClientsDelegatedResult> => rpcOk([client()]),
    getOAuthClient: async () => rpcOk(client()),
    countOAuthClients: async () => rpcOk(1),
    countUsers: async () => rpcOk({ active: 0, suspended: 0, deleted: 0 }),
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
    setOAuthClientOwner: async (input): Promise<SetOAuthClientOwnerDelegatedResult> => {
      calls.setOAuthClientOwner.push(input);
      return rpcOk(null);
    },
    setOAuthClientAppUrl: async (input): Promise<SetOAuthClientAppUrlDelegatedResult> => {
      calls.setOAuthClientAppUrl.push(input);
      return rpcOk(null);
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
    // **登録フォームぶんの CSRF トークンだけが残る。** 新規登録（#508 の
    // 範囲外）のためのもので、行内の操作（持ち主・表示用 URL・失効）用では
    // ない。
    expect(html).toMatch(/name="csrf_token"/);
  });

  /**
   * ボタンの variant だけ直した PR（issue #535）で form の契約まで
   * 壊していないかを見る。既存のテストは直接 POST を組むので、描いた
   * HTML の `name=`/`action=` と実際に一致しているかはここでしか見ていない。
   */
  it("登録フォームの action / method / name / CSRF が変わっていない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      listOAuthClients: async () => rpcOk([]),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const html = await response.text();

    expect(html).toContain('<form method="post" action="/clients"');
    expect(html).toMatch(/name="csrf_token"/);
    expect(html).toContain('name="redirect_uris"');
    expect(html).toContain('name="scopes"');
    expect(html).toContain('name="logo_url"');
  });

  /**
   * **行内の操作フォーム 3 種を一覧から外した**（#508、`/nfc` を #481 で
   * 外したのと同じ形）。詳細（`/clients/:clientId`）へ寄せたので、一覧の
   * 行自体はこれらの action を一切持たない——一次パーティかどうかに
   * 関わらず。
   */
  it("行内の持ち主・表示用 URL・失効フォームを一覧から外した（#508）", async () => {
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

    const html = await response.text();
    expect(html).not.toContain('action="/clients/owner"');
    expect(html).not.toContain('action="/clients/app-url"');
    expect(html).not.toContain('action="/clients/disable"');
    // **代わりに、クライアント名が詳細へのリンクになっている。**
    expect(html).toContain('href="/clients/app_a"');
    expect(html).toContain('href="/clients/app_b"');
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

describe("GET /clients/:clientId（#473）", () => {
  it("概要・redirect_uri・scope・操作をまとめて描く", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(
          client({
            clientId: "app_0001",
            name: "My App",
            redirectUris: ["https://example.com/callback", "https://example.com/other"],
            scopes: ["openid", "profile"],
          }),
        ),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("My App");
    expect(html).toContain("https://example.com/callback");
    expect(html).toContain("https://example.com/other");
    expect(html).toContain("openid");
    expect(html).toContain("profile");
    expect(html).toContain('data-panel="overview"');
    expect(html).toContain('data-panel="redirect-uris"');
    expect(html).toContain('data-panel="audit"');
    expect(html).toContain('data-panel="operations"');
  });

  /**
   * **タブのボタン列（#470 の `data-tabs`、admin-island.ts の `attachTabs`）。**
   * `data-tab` の値が `data-panel` と 1 対 1 で揃っていること、見出しの
   * 文言がそのままラベルになっていることを確かめる。実際に切り替わる
   * 挙動そのものは `admin-island.test.ts` が持つ——ここでは markup の
   * 対応関係だけを見る。
   */
  it("data-tab の列を data-panel と揃えて持つ。JS が無ければ hidden を付けない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001" })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain('data-tab="overview"');
    expect(html).toContain('data-tab="redirect-uris"');
    expect(html).toContain('data-tab="audit"');
    expect(html).toContain('data-tab="operations"');
    expect(html).toContain(">概要<");
    expect(html).toContain(">redirect_uri<");
    expect(html).toContain(">監査ログ<");
    expect(html).toContain(">操作<");
    // **JS 無しで縦に並ぶ絶対条件。** サーバーは `hidden` を 1 つも付けない
    // ——付けるのは `attachTabs` だけ。
    expect(html).not.toMatch(/data-panel="[^"]*"[^>]*\shidden/);
  });

  it("client_id と redirect_uri にコピー用の目印（data-copy）を付ける", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001", redirectUris: ["https://example.com/cb"] })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain('data-copy="app_0001" hidden');
    expect(html).toContain('data-copy="https://example.com/cb" hidden');
  });

  /**
   * 監査ログの表が並べ替えられること（#488）。**日時の型を `/audit` 本体と
   * 揃える**——`text` 扱いだと文字列として並べ替わり、「2026/11/5」と
   * 「2026/11/12」のような表記で順序が狂う（指摘: 3b）。
   */
  it("監査ログの表に data-sortable を持ち、日時の型が /audit 本体と揃っている", async () => {
    const sessionCookie = await loginAsApproved();
    // **0 件だと空状態の文言に差し替わり、表自体が描かれない。** 少なくとも
    // 1 件無いと「data-sortable が出ない」が「属性を忘れた」のか「0 件
    // だから」のか区別が付かない（#470 の asset-coverage.test.ts と同じ
    // 注意）。
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001" })),
      listAuditLogs: async () =>
        rpcOk({
          entries: [
            {
              id: "aud_1",
              event: "oauth.client.created",
              userId: "usr_admin",
              actor: "admin-worker",
              outcome: "success",
              reason: null,
              metadata: null,
              ipHash: null,
              userAgent: null,
              createdAt: "2026-10-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("data-sortable");
    expect(html).toContain('data-sort="date">日時');
    expect(html).toContain('data-sort="text">イベント');
  });

  it("一次パーティは失効フォームを出さない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_dashboard", isFirstParty: true })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_dashboard`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).not.toContain('action="/clients/disable"');
    expect(html).toContain("この画面からは失効させられません");
  });

  /**
   * **一覧（`clients-page.tsx`）には 3 つの操作フォームがあり、この画面は
   * 2 つしか無かった**（3b のレビュー）。「一覧と同じ操作です」と言い切る
   * 説明文があるのに app_url だけ変えられないのは、表示だけで操作できない
   * 中途半端な詳細ページになる——説明文を弱めるのではなく、フォームを足す。
   */
  it("表示用 URL（app_url）を変更するフォームも持つ", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001", appUrl: "https://app.example/" })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain('action="/clients/app-url"');
    expect(html).toContain('value="https://app.example/"');
    expect(html).toContain('name="from" value="detail"');
  });

  it("appUrl があれば target=_blank と rel=noopener noreferrer 付きでリンクにする", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001", appUrl: "https://app.example/" })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toMatch(
      /<a href="https:\/\/app\.example\/" target="_blank" rel="noopener noreferrer"/,
    );
  });

  it("appUrl が無ければリンクを出さない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001", appUrl: null })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).not.toMatch(/<a href="[^"]*" target="_blank"/);
  });

  it("持ち主が居なければ — を出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001", ownerUserId: null })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).not.toContain("/users/usr_");
  });

  it("持ち主が居れば名前で /users/<id> へリンクする（getUsersByIds 経由）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001", ownerUserId: "usr_alice" })),
      getUsersByIds: async () =>
        rpcOk([{ id: "usr_alice", username: "alice", displayName: "Alice", status: "active" }]),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain('<a href="/users/usr_alice"');
    expect(html).toContain("Alice");
  });

  it("持ち主の名前が引けなければ、リンクにせず短縮 ID を出す（「不明」とは書かない）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001", ownerUserId: "usr_does_not_exist" })),
      // **見つからなかった ID は結果から黙って落ちる**（`GetUsersByIdsDelegatedResult` の契約）。
      getUsersByIds: async () => rpcOk([]),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).not.toContain('<a href="/users/usr_does_not_exist"');
    expect(html).not.toContain("不明");
    expect(html).toContain('title="usr_does_not_exist"');
    expect(html).toContain("usr_does…");
  });

  it("監査ログが全滅したら「いま取得できません」を出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001" })),
      listAuditLogs: async () => rpcErr(RpcErrorCode.Internal, "boom"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("いま監査ログを取得できません");
  });

  it("監査ログが一部しか取れなくても、取れた分は出す", async () => {
    const sessionCookie = await loginAsApproved();
    let call = 0;
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001" })),
      listAuditLogs: async (input) => {
        call += 1;
        if (input.event === "oauth.client.created") {
          return rpcOk({
            entries: [
              {
                id: "aud_1",
                event: "oauth.client.created",
                userId: "usr_admin",
                actor: "admin-worker",
                outcome: "success",
                reason: null,
                metadata: null,
                ipHash: null,
                userAgent: null,
                createdAt: "2026-10-01T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          });
        }
        return rpcErr(RpcErrorCode.Internal, "boom");
      },
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(call).toBe(4);
    expect(html).toContain("oauth.client.created");
    expect(html).not.toContain("いま監査ログを取得できません");
  });

  it("持ち主と、監査ログの「操作した管理者」の両方を名前で出す（#482）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001", ownerUserId: "usr_owner" })),
      listAuditLogs: async (input) => {
        if (input.event === "oauth.client.created") {
          return rpcOk({
            entries: [
              {
                id: "aud_1",
                event: "oauth.client.created",
                userId: "usr_admin",
                actor: "admin-worker",
                outcome: "success",
                reason: null,
                metadata: null,
                ipHash: null,
                userAgent: null,
                createdAt: "2026-10-01T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          });
        }
        return rpcOk({ entries: [], nextCursor: null });
      },
      getUsersByIds: async () =>
        rpcOk([
          { id: "usr_owner", username: "owner", displayName: "持ち主", status: "active" },
          { id: "usr_admin", username: "admin", displayName: "管理者", status: "active" },
        ]),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("持ち主 (@owner)");
    expect(html).toContain("管理者 (@admin)");
    expect(html).toContain('href="/users/usr_owner"');
    expect(html).toContain('href="/users/usr_admin"');
  });

  it("存在しない clientId は 404 で一覧へ戻す道を示す（行き止まりにしない）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcErr(RpcErrorCode.NotFound, "no such client"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_missing`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("見つかりません");
    expect(html).toContain('href="/clients"');
  });

  it("invalid_input も見つからない扱いにする", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcErr(RpcErrorCode.InvalidInput, "malformed"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_missing`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(404);
  });

  it("それ以外のエラーは 503", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcErr(RpcErrorCode.Internal, "boom"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app_missing`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(503);
  });

  /**
   * **登録順の実測**（issue #473 / `users.routes.tsx:308` と同じ罠の確認）。
   * `GET /clients/:clientId` と `POST /clients/disable` / `POST /clients/owner`
   * はメソッドが違うので、どちらを先に登録しても食い合わない——それを
   * 「たぶんそう」ではなく実際に両方叩いて確かめる。
   */
  it("POST /clients/disable・/clients/owner を GET /clients/:clientId が食わない", async () => {
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

    const disableResponse = await app.fetch(
      new Request(`${ORIGIN}/clients/disable`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ client_id: "app_0001", confirm: "true", csrf_token }),
      }),
      env,
      executionContext(),
    );
    expect(disableResponse.status).toBe(200);
    expect(calls.disableOAuthClient).toHaveLength(1);

    const ownerResponse = await app.fetch(
      new Request(`${ORIGIN}/clients/owner`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ client_id: "app_0001", owner_user_id: "usr_x", csrf_token }),
      }),
      env,
      executionContext(),
    );
    expect(ownerResponse.status).toBe(200);
    expect(calls.setOAuthClientOwner).toHaveLength(1);

    // 逆方向——`GET /clients/owner` は「owner という clientId」の詳細として
    // 扱われ、見つからず 404 になる（`POST` 専用の操作ルートを吸ってはいない）。
    const { rpc: notFoundRpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcErr(RpcErrorCode.NotFound, "no such client"),
    });
    const notFoundApp = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: notFoundRpc });
    const getOwnerAsDetail = await notFoundApp.fetch(
      new Request(`${ORIGIN}/clients/owner`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    expect(getOwnerAsDetail.status).toBe(404);
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
    const html = await response.text();
    expect(html).toContain(`<link rel="stylesheet" href="${KIWA_STYLESHEET_PATH}"/>`);
    expect(html).toContain('href="/clients"');
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

  /**
   * **2 段階確認（指摘: 3b）。** `confirm` が無い 1 回目は、実際には
   * 何も変えず確認カードを返すだけ——`disableOAuthClient` が呼ばれて
   * いないことまで見る（画面の文言だけでは、サーバー側が実は実行して
   * いた、という事故を拾えない）。
   */
  it("confirm が無ければ disableOAuthClient を呼ばず、確認カードを返す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001", name: "Confirm Target" })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
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
        body: new URLSearchParams({ client_id: "app_0001", from: "detail", csrf_token }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    // **これが本体。** `disableOAuthClient` が 1 回も呼ばれていないこと
    // ——確認カードの文言が出ているだけでは、サーバーが実は実行済み
    // だった、という形の事故を拾えない。
    expect(calls.disableOAuthClient).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("Confirm Target");
    expect(html).toContain("この操作は管理画面から元に戻せません");
    expect(html).toContain('name="confirm" value="true"');
  });

  /**
   * **無言の 200 にしない（指摘: 3b）。** `clients-page.tsx` に失効ボタンは
   * 無いので UI からこの分岐を通る経路は無いが、`POST` は直接叩けるので
   * 古いブックマークやスクリプトがここを通りうる。`error` 無しで一覧を
   * そのまま返すと、呼んだ側からは「200 = 成功したように見えて実は
   * 何もしていない」行き止まりになる。
   */
  it("一覧から（from=detail 無し）confirm 無しで来たら、何もせず理由を表示する", async () => {
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
    expect(calls.disableOAuthClient).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("失効には確認が要ります");
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
        body: new URLSearchParams({ client_id: "app_0001", confirm: "true", csrf_token }),
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
        body: new URLSearchParams({ client_id: "app_dashboard", confirm: "true", csrf_token }),
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
        body: new URLSearchParams({ client_id: "app_unknown", confirm: "true", csrf_token }),
      }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("既に失効しています");
  });

  it("from=detail なら一覧ではなく詳細画面を描き直す（#473）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001", name: "Detail Target" })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
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
        body: new URLSearchParams({
          client_id: "app_0001",
          from: "detail",
          confirm: "true",
          csrf_token,
        }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    // **詳細画面が描き直されたことの証拠。** 一覧（`clients-page.tsx`）には
    // 出ない `data-panel` が出ていること、一覧の見出しではなく詳細の
    // 見出しが出ていることの両方で確かめる。
    expect(html).toContain('data-panel="overview"');
    expect(html).toContain("Detail Target");
  });
});

describe("GET /clients（持ち主の表示、#482）", () => {
  it("持ち主を名前で出す。解決できなければ ID の先頭だけ、いなければ — を出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      listOAuthClients: async () =>
        rpcOk([
          client({ clientId: "app_owned", ownerUserId: "usr_alice" }),
          client({ clientId: "app_unresolved", ownerUserId: "usr_does_not_resolve" }),
          client({ clientId: "app_unowned", ownerUserId: null }),
        ]),
      getUsersByIds: async () =>
        rpcOk([{ id: "usr_alice", username: "alice", displayName: "アリス", status: "active" }]),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("アリス (@alice)");
    expect(html).toContain('href="/users/usr_alice"');
    // **「不明」と書かない**（#471 と同じ方針）。先頭 8 文字 + `…` を出す。
    expect(html).toContain("usr_does…");
    expect(html).not.toContain("持ち主: usr_does_not_resolve");
    expect(html).toContain("持ち主: <span");
  });
});

describe("POST /clients/owner", () => {
  it("CSRF トークンが無ければ 403 で、setOAuthClientOwner を呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/owner`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "app_0001", owner_user_id: "usr_alice" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.setOAuthClientOwner).toHaveLength(0);
  });

  it("CSRF が通れば setOAuthClientOwner を actorUserId 付きで呼ぶ", async () => {
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
      new Request(`${ORIGIN}/clients/owner`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({
          client_id: "app_0001",
          owner_user_id: "usr_alice",
          csrf_token,
        }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(calls.setOAuthClientOwner).toEqual([
      { actorUserId: SUB, clientId: "app_0001", ownerUserId: "usr_alice" },
    ]);
    const html = await response.text();
    expect(html).toContain("持ち主を変更しました。");
  });

  it("空欄で送ると null（持ち主を外す）として渡す", async () => {
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

    await app.fetch(
      new Request(`${ORIGIN}/clients/owner`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ client_id: "app_0001", owner_user_id: "", csrf_token }),
      }),
      env,
      executionContext(),
    );

    expect(calls.setOAuthClientOwner).toEqual([
      { actorUserId: SUB, clientId: "app_0001", ownerUserId: null },
    ]);
  });

  it("実在しない userId（invalid_input）は言い直す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      setOAuthClientOwner: async () =>
        rpcErr(RpcErrorCode.InvalidInput, "ownerUserId does not exist"),
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
      new Request(`${ORIGIN}/clients/owner`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({
          client_id: "app_0001",
          owner_user_id: "usr_does_not_exist",
          csrf_token,
        }),
      }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).not.toContain("does not exist");
    expect(html).toContain("見つかりません");
  });

  it("from=detail なら一覧ではなく詳細画面を描き直す（#473）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001", name: "Detail Target" })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrf_token = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/owner`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({
          client_id: "app_0001",
          owner_user_id: "usr_alice",
          from: "detail",
          csrf_token,
        }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-panel="overview"');
    expect(html).toContain("Detail Target");
  });
});

describe("GET /clients（表示用 URL の表示）", () => {
  it("URL があれば出し、無ければ — を出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      listOAuthClients: async () =>
        rpcOk([
          client({ clientId: "app_with_url", appUrl: "https://app.example/" }),
          client({ clientId: "app_without_url", appUrl: null }),
        ]),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("表示用 URL: https://app.example/");
    expect(html).toContain("表示用 URL: —");
  });
});

describe("POST /clients/app-url", () => {
  it("CSRF トークンが無ければ 403 で、setOAuthClientAppUrl を呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeIdentityAdmin();
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app-url`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "app_0001", app_url: "https://app.example/" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.setOAuthClientAppUrl).toHaveLength(0);
  });

  it("CSRF が通れば setOAuthClientAppUrl を actorUserId 付きで呼ぶ", async () => {
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
      new Request(`${ORIGIN}/clients/app-url`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({
          client_id: "app_0001",
          app_url: "https://app.example/",
          csrf_token,
        }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(calls.setOAuthClientAppUrl).toEqual([
      { actorUserId: SUB, clientId: "app_0001", appUrl: "https://app.example/" },
    ]);
    const html = await response.text();
    expect(html).toContain("表示用 URL を変更しました。");
  });

  it("空欄で送ると null（外す）として渡す", async () => {
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

    await app.fetch(
      new Request(`${ORIGIN}/clients/app-url`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ client_id: "app_0001", app_url: "", csrf_token }),
      }),
      env,
      executionContext(),
    );

    expect(calls.setOAuthClientAppUrl).toEqual([
      { actorUserId: SUB, clientId: "app_0001", appUrl: null },
    ]);
  });

  it("不正な URL（invalid_input）は言い直す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      setOAuthClientAppUrl: async () =>
        rpcErr(RpcErrorCode.InvalidInput, "appUrl is not a usable https URL"),
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
      new Request(`${ORIGIN}/clients/app-url`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({
          client_id: "app_0001",
          app_url: "http://app.example/",
          csrf_token,
        }),
      }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).not.toContain("usable https URL");
    expect(html).toContain("https で始まる");
  });

  it("from=detail なら一覧ではなく詳細画面を描き直す（#473）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeIdentityAdmin({
      getOAuthClient: async (): Promise<GetOAuthClientDelegatedResult> =>
        rpcOk(client({ clientId: "app_0001", name: "Detail Target" })),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), identityAdmin: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/clients/app_0001`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrf_token = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/clients/app-url`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({
          client_id: "app_0001",
          app_url: "https://app.example/",
          from: "detail",
          csrf_token,
        }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-panel="overview"');
    expect(html).toContain("Detail Target");
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
