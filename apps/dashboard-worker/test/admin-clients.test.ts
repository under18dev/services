import { DEV_SESSION_COOKIE_NAME, rpcErr, rpcOk } from "@u18/contracts";
import type { OAuthClientSummary } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import {
  ADMIN_CLIENTS_CREATE_PATH,
  ADMIN_CLIENTS_DISABLE_PATH,
  ADMIN_CLIENTS_PATH,
  PROFILE_PATH,
} from "../src/presentation/http/ui/asset-paths";
import { ORIGIN, envWith, executionContext, neverCalled } from "./helpers";

/**
 * OAuth クライアントの管理画面（`/account/admin/clients`、#308 / #333）。
 *
 * ## ここでしか確かめられないこと
 *
 * 1. **サイドバーの出し分けが、本物の並びで効いている**こと。
 *    `account-nav.test.ts` は `accountNavFor` を作り物の並びで見ている。
 *    **本物に `adminOnly` が 1 件も無かったあいだ、出し分けは
 *    「何を壊しても緑」だった**（あの見張りはそのための仮置きで、
 *    このファイルが置き換えている）
 * 2. **管理者でない人には 404** であること。`isAdmin` を見て先に弾く
 *    形にしていないので、**auth-worker の `not_found` が 404 まで
 *    通っている**ことを確かめる必要がある
 * 3. **`client_secret` が応答の本文にしか出ない**こと。URL にも
 *    `Location` にも `Set-Cookie` にも出さない
 */

const COOKIE = `${DEV_SESSION_COOKIE_NAME}=token-value`;

const PROFILE = {
  id: "usr_test",
  username: "taro",
  displayName: "Taro",
  email: "taro@example.com",
  emailVerified: true,
  status: "active" as const,
  isAdmin: true,
  createdAt: "2026-10-24T00:00:00.000Z",
};

function session(isAdmin: boolean) {
  return {
    getSession: async () => rpcOk({ id: "ses_1", userId: "usr_test", isAdmin }),
    getUserProfile: async () => rpcOk({ ...PROFILE, isAdmin }),
    listPasskeys: async () => rpcOk([]),
    listSessions: async () => rpcOk([]),
    listGrants: async () => rpcOk([]),
  };
}

const CLIENT: OAuthClientSummary = {
  clientId: "demo-app",
  name: "デモ",
  clientType: "confidential",
  isFirstParty: false,
  logoUrl: null,
  redirectUris: ["https://demo.example/callback"],
  scopes: ["openid", "profile"],
  createdAt: "2026-10-24T00:00:00.000Z",
  disabledAt: null,
};

const FIRST_PARTY: OAuthClientSummary = {
  ...CLIENT,
  clientId: "u18-dashboard",
  name: "u18 ダッシュボード",
  isFirstParty: true,
};

/** 管理者でないセッションに auth-worker が返すもの（`not_found` に畳まれている）。 */
const DENIED = { listOAuthClients: async () => rpcErr("not_found", "no such resource") };

function fetchPage(path: string, isAdmin: boolean, admin: object, init: RequestInit = {}) {
  return createApp().fetch(
    new Request(`${ORIGIN}${path}`, { headers: { Cookie: COOKIE }, ...init }),
    envWith(session(isAdmin) as never, undefined, admin as never),
    executionContext(),
  );
}

/** 画面から CSRF の hidden を読む。**テストが値を作らない** —— 本物を使う。 */
function csrfTokenOf(html: string): string {
  const match = /name="csrf_token" value="([^"]+)"/.exec(html);
  if (match?.[1] === undefined) throw new Error("CSRF トークンが描画されていない");
  return match[1];
}

function cookieOf(response: Response): string {
  const pairs = response.headers.getSetCookie().map((raw) => raw.split(";")[0] ?? "");
  return [COOKIE, ...pairs].join("; ");
}

/** 画面を開いて、送信に要るもの（Cookie と CSRF）を揃える。 */
async function openAdminPage(admin: object): Promise<{ cookie: string; csrf: string }> {
  const response = await fetchPage(ADMIN_CLIENTS_PATH, true, admin);
  const html = await response.text();
  return { cookie: cookieOf(response), csrf: csrfTokenOf(html) };
}

function post(path: string, admin: object, cookie: string, fields: Record<string, string>) {
  return createApp().fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
    }),
    envWith(session(true) as never, undefined, admin as never),
    executionContext(),
  );
}

describe("サイドバーの管理の節", () => {
  it("管理者には出る", async () => {
    const response = await fetchPage(PROFILE_PATH, true, {});
    const html = await response.text();

    expect(html).toContain(ADMIN_CLIENTS_PATH);
    expect(html).toContain("OAuth クライアント");
    expect(html).toContain("管理");
  });

  it("管理者でなければ、項目も見出しも出ない", async () => {
    const response = await fetchPage(PROFILE_PATH, false, {});
    const html = await response.text();

    // **行き先が消えていること。** ラベルだけ消して href が残ると、
    // サイドバーの HTML から管理機能の存在が読める。
    expect(html).not.toContain(ADMIN_CLIENTS_PATH);
    expect(html).not.toContain("OAuth クライアント");
  });

  it("セッションが取れないときは出さない", async () => {
    // `navFlags` は「分からなければ管理者ではない」へ倒す。
    const broken = {
      ...session(true),
      getSession: async () => rpcErr("internal", "boom"),
    };
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${PROFILE_PATH}`, { headers: { Cookie: COOKIE } }),
      envWith(broken as never, undefined, {} as never),
      executionContext(),
    );

    expect(await response.text()).not.toContain(ADMIN_CLIENTS_PATH);
  });
});

describe("GET /account/admin/clients", () => {
  it("管理者でなければ 404 を返し、権限の話をしない", async () => {
    const response = await fetchPage(ADMIN_CLIENTS_PATH, false, DENIED);

    expect(response.status).toBe(404);
    const html = await response.text();
    // 「権限がありません」と書くと、管理機能の存在が伝わる。
    expect(html).not.toContain("権限");
    expect(html).not.toContain("管理者");
  });

  it("管理者には一覧と登録 form が出る", async () => {
    const response = await fetchPage(ADMIN_CLIENTS_PATH, true, {
      listOAuthClients: async () => rpcOk([CLIENT]),
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("demo-app");
    expect(html).toContain("https://demo.example/callback");
    expect(html).toContain(`action="${ADMIN_CLIENTS_CREATE_PATH}"`);
    expect(html).toContain('name="csrf_token"');
  });

  it("Redirect URI をリンクにしない", async () => {
    const response = await fetchPage(ADMIN_CLIENTS_PATH, true, {
      listOAuthClients: async () => rpcOk([CLIENT]),
    });
    const html = await response.text();

    // 押せるようにすると、一覧を見ただけで第三者のサーバーへ遷移できる。
    expect(html).not.toContain('href="https://demo.example/callback"');
  });

  it("一次パーティには失効のボタンを出さず、理由を書く", async () => {
    const response = await fetchPage(ADMIN_CLIENTS_PATH, true, {
      listOAuthClients: async () => rpcOk([FIRST_PARTY]),
    });
    const html = await response.text();

    // **押してから断られる形にしない。**
    expect(html).not.toContain(`action="${ADMIN_CLIENTS_DISABLE_PATH}"`);
    expect(html).toContain("失効させられません");
  });

  it("この画面は JS を読まない", async () => {
    const response = await fetchPage(ADMIN_CLIENTS_PATH, true, {
      listOAuthClients: async () => rpcOk([]),
    });

    // `client_secret` が 1 度しか返らないので、JS の有無で出し分けない。
    expect(await response.text()).not.toContain("<script");
  });
});

describe("POST /account/admin/clients/create", () => {
  const created = {
    listOAuthClients: async () => rpcOk([CLIENT]),
    createOAuthClient: async () =>
      rpcOk({ client: CLIENT, clientSecret: "s3cret-value-not-in-url" }),
  };

  it("client_secret は本文に 1 度だけ出て、URL にも Cookie にも出ない", async () => {
    const page = await openAdminPage(created);
    const response = await post(ADMIN_CLIENTS_CREATE_PATH, created, page.cookie, {
      csrf_token: page.csrf,
      client_id: "demo-app",
      name: "デモ",
      client_type: "confidential",
      redirect_uris: "https://demo.example/callback",
    });

    expect(response.status).toBe(200);
    // **リダイレクトしない。** 秘密を次の GET へ運ぶ必要が出る。
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.getSetCookie().join(" ")).not.toContain("s3cret-value-not-in-url");
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const html = await response.text();
    expect(html).toContain("s3cret-value-not-in-url");
    // **操作の成否を先に言う。** 取り損ねた人が押し直して二重に作らないため。
    expect(html).toContain("登録しました");
  });

  it("public クライアントでは秘密の枠ごと出さない", async () => {
    const publicClient = {
      listOAuthClients: async () => rpcOk([]),
      createOAuthClient: async () =>
        rpcOk({ client: { ...CLIENT, clientType: "public" as const }, clientSecret: null }),
    };
    const page = await openAdminPage(publicClient);
    const response = await post(ADMIN_CLIENTS_CREATE_PATH, publicClient, page.cookie, {
      csrf_token: page.csrf,
      client_id: "spa",
      name: "SPA",
      client_type: "public",
      redirect_uris: "https://spa.example/cb",
    });

    const html = await response.text();
    // **空欄を出さない。**「二度と表示されません」と書いた枠が空だと、
    // 取り損ねたと読める。
    expect(html).not.toContain(">client_secret<");
    expect(html).toContain("client_secret はありません");
  });

  it("CSRF トークンが無ければ RPC を呼ばない", async () => {
    const guarded = {
      listOAuthClients: async () => rpcOk([]),
      createOAuthClient: () => neverCalled("createOAuthClient"),
    };
    const page = await openAdminPage(guarded);

    const response = await post(ADMIN_CLIENTS_CREATE_PATH, guarded, page.cookie, {
      client_id: "demo-app",
      name: "デモ",
      client_type: "confidential",
      redirect_uris: "https://demo.example/callback",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("もう一度");
  });

  it("client_id が重複したら、やり直せる形で言う", async () => {
    const conflicting = {
      listOAuthClients: async () => rpcOk([CLIENT]),
      createOAuthClient: async () => rpcErr("conflict", "client_id already exists"),
    };
    const page = await openAdminPage(conflicting);
    const response = await post(ADMIN_CLIENTS_CREATE_PATH, conflicting, page.cookie, {
      csrf_token: page.csrf,
      client_id: "demo-app",
      name: "デモ",
      client_type: "confidential",
      redirect_uris: "https://demo.example/callback",
    });

    const html = await response.text();
    expect(html).toContain("既に使われています");
    // **一覧ごと消さない。** 入力を直してやり直す画面である。
    expect(html).toContain("demo-app");
  });

  it("再認証が要るときは、そう言う", async () => {
    const stale = {
      listOAuthClients: async () => rpcOk([]),
      createOAuthClient: async () => rpcErr("reauthentication_required", "stale"),
    };
    const page = await openAdminPage(stale);
    const response = await post(ADMIN_CLIENTS_CREATE_PATH, stale, page.cookie, {
      csrf_token: page.csrf,
      client_id: "demo-app",
      name: "デモ",
      client_type: "confidential",
      redirect_uris: "https://demo.example/callback",
    });

    expect(await response.text()).toContain("ログインし直し");
  });

  it("管理者でなくなっていたら 404", async () => {
    const denied = {
      listOAuthClients: async () => rpcOk([]),
      createOAuthClient: async () => rpcErr("not_found", "no such resource"),
    };
    const page = await openAdminPage(denied);
    const response = await post(ADMIN_CLIENTS_CREATE_PATH, denied, page.cookie, {
      csrf_token: page.csrf,
      client_id: "demo-app",
      name: "デモ",
      client_type: "confidential",
      redirect_uris: "https://demo.example/callback",
    });

    expect(response.status).toBe(404);
  });
});

describe("POST /account/admin/clients/disable", () => {
  it("失効させると、何が止まったかを言う", async () => {
    const disabling = {
      listOAuthClients: async () => rpcOk([{ ...CLIENT, disabledAt: "2026-10-30T00:00:00.000Z" }]),
      disableOAuthClient: async () => rpcOk({ disabled: true }),
    };
    const page = await openAdminPage(disabling);
    const response = await post(ADMIN_CLIENTS_DISABLE_PATH, disabling, page.cookie, {
      csrf_token: page.csrf,
      client_id: "demo-app",
    });

    const html = await response.text();
    // **「アクセスを停止しました」とは書かない。** 発行済みのトークンは
    // 期限まで生きている（止まるのは以後の認可だけ）。
    expect(html).not.toContain("アクセスを停止");
    expect(html).toContain("新しい認可は通りません");
  });

  it("2 度目は「既に失効しています」と言う（冪等）", async () => {
    const already = {
      listOAuthClients: async () => rpcOk([{ ...CLIENT, disabledAt: "2026-10-30T00:00:00.000Z" }]),
      disableOAuthClient: async () => rpcOk({ disabled: false }),
    };
    const page = await openAdminPage(already);
    const response = await post(ADMIN_CLIENTS_DISABLE_PATH, already, page.cookie, {
      csrf_token: page.csrf,
      client_id: "demo-app",
    });

    // **「失効させました」と言い切らない。** 今回は何も変わっていない。
    expect(await response.text()).toContain("既に失効しています");
  });

  it("CSRF トークンが無ければ RPC を呼ばない", async () => {
    const guarded = {
      listOAuthClients: async () => rpcOk([CLIENT]),
      disableOAuthClient: () => neverCalled("disableOAuthClient"),
    };
    const page = await openAdminPage(guarded);

    const response = await post(ADMIN_CLIENTS_DISABLE_PATH, guarded, page.cookie, {
      client_id: "demo-app",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("もう一度");
  });
});
