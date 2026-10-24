import {
  DEV_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  buildClearedSessionCookie,
  rpcErr,
  rpcOk,
} from "@u18/contracts";
import type { GrantListItem, RpcErrorCode, SessionListItem, UserProfile } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE_PATH } from "../src/base-path";
import app from "../src/index";
import { ORIGIN, envWith, executionContext, neverCalled } from "./helpers";

/**
 * dashboard-worker の HTTP 層。
 *
 * この Worker の責務は「Cookie を読み、Origin を確かめ、RPC の失敗を
 * HTTP ステータスへ翻訳する」こと。Identity の判断そのものは auth-worker が持つ。
 * ここではその 3 つだけを、fake の RPC を差して検証する。
 */

/**
 * `/account` 接頭辞を付けて叩く。
 *
 * 本番の Workers route（`auth.under18.dev/account/*`）は、一致した接頭辞を
 * URL から**取り除かない**。Worker には `/account/api/me` がそのまま届くので、
 * ハンドラ側もその形で登録してある（#106）。テストが接頭辞を省くと、
 * 本番で 1 つも叩けない状態のまま緑になる。
 */
async function request(path: string, env: Env, init: RequestInit = {}): Promise<Response> {
  return await rawRequest(`${ACCOUNT_BASE_PATH}${path}`, env, init);
}

/** 接頭辞を付けずに叩く。「付けないと届かない」ことを示すテストだけが使う。 */
async function rawRequest(path: string, env: Env, init: RequestInit = {}): Promise<Response> {
  return await app.fetch(new Request(`${ORIGIN}${path}`, init), env, executionContext());
}

const PROFILE: UserProfile = {
  id: "usr_test",
  username: "taro",
  displayName: "Taro",
  email: "taro@example.com",
  emailVerified: true,
  status: "active",
  createdAt: "2026-10-24T00:00:00.000Z",
};

describe("Cookie の名前は環境で切り替わる", () => {
  const identity = { getUserProfile: async () => rpcOk(PROFILE) };

  it("development では接頭辞なしの Cookie を読む", async () => {
    const response = await request("/api/me", envWith(identity, "development"), {
      headers: { Cookie: `${DEV_SESSION_COOKIE_NAME}=token-value` },
    });

    expect(response.status).toBe(200);
  });

  it("production では __Host- 付きの Cookie を読む", async () => {
    const response = await request("/api/me", envWith(identity, "production"), {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=token-value` },
    });

    expect(response.status).toBe(200);
  });

  it("production で開発用の名前の Cookie は読まない", async () => {
    // 以前ここが "u18_session" にハードコードされており、本番では
    // __Host- 付きの Cookie を永久に読めなかった。その回帰。
    const response = await request("/api/me", envWith(identity, "production"), {
      headers: { Cookie: `${DEV_SESSION_COOKIE_NAME}=token-value` },
    });

    expect(response.status).toBe(401);
  });
});

describe("Cookie が無ければ RPC を呼ばずに 401", () => {
  const identity = {
    getUserProfile: () => neverCalled("getUserProfile"),
    listSessions: () => neverCalled("listSessions"),
    revokeSession: () => neverCalled("revokeSession"),
  } as never;

  it.each(["/api/me", "/api/me/sessions"])("%s", async (path) => {
    const response = await request(path, envWith(identity));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("DELETE /api/me/sessions/:id", async () => {
    const response = await request("/api/me/sessions/ses_x", envWith(identity), {
      method: "DELETE",
      headers: { Origin: ORIGIN },
    });

    expect(response.status).toBe(401);
  });
});

describe("状態を変える操作の Origin 検証", () => {
  const identity = { revokeSession: () => neverCalled("revokeSession") } as never;
  const cookie = `${DEV_SESSION_COOKIE_NAME}=token-value`;

  it("Origin が無ければ拒否する", async () => {
    // 「無ければ通す」にすると、ヘッダを落とせる経路があった時点で
    // CSRF 対策が SameSite 頼みになる。
    const response = await request("/api/me/sessions/ses_x", envWith(identity), {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("別オリジンからは拒否する", async () => {
    const response = await request("/api/me/sessions/ses_x", envWith(identity), {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
  });

  it("同一オリジンなら RPC まで到達する", async () => {
    const response = await request(
      "/api/me/sessions/ses_x",
      envWith({ revokeSession: async () => rpcOk({ revoked: true, self: false }) }),
      { method: "DELETE", headers: { Cookie: cookie, Origin: ORIGIN } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revoked: true });
  });

  it("GET には Origin 検証を課さない", async () => {
    // 状態を変えないので、通常のブラウザ遷移を壊さない。
    const response = await request(
      "/api/me",
      envWith({ getUserProfile: async () => rpcOk(PROFILE) }),
      { headers: { Cookie: cookie } },
    );

    expect(response.status).toBe(200);
  });
});

describe("RPC の失敗を HTTP ステータスへ翻訳する", () => {
  const cookie = `${DEV_SESSION_COOKIE_NAME}=token-value`;

  const cases: ReadonlyArray<[RpcErrorCode, number]> = [
    ["unauthenticated", 401],
    ["forbidden", 403],
    ["not_found", 404],
    // 以下は利用者から見れば「Identity が使えない」に畳み込む。
    ["invalid_input", 503],
    ["rate_limited", 503],
    ["internal", 503],
  ];

  it.each(cases)("%s は %i になる", async (code, status) => {
    const response = await request(
      "/api/me/sessions",
      envWith({ listSessions: async () => rpcErr(code, "internal detail from auth-worker") }),
      { headers: { Cookie: cookie } },
    );

    expect(response.status).toBe(status);
  });

  it("auth-worker 側のメッセージを応答に載せない", async () => {
    const response = await request(
      "/api/me/sessions",
      envWith({
        listSessions: async () => rpcErr("internal", "sqlite: no such table: sessions"),
      }),
      { headers: { Cookie: cookie } },
    );

    // 内部の事情が利用者へ漏れると、構成を推測する材料になる。
    expect(await response.text()).not.toContain("sqlite");
  });

  it("RPC が例外を投げても 503 に畳み込む", async () => {
    // Worker の停止やデプロイ中の不整合で throw されうる。
    // 素通しすると Presentation が 500 以外を選べなくなる。
    const response = await request(
      "/api/me/sessions",
      envWith({
        listSessions: () => {
          throw new Error("service binding is not available");
        },
      }),
      { headers: { Cookie: cookie } },
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("service binding");
  });

  it("セッションが無効なら 401", async () => {
    const response = await request(
      "/api/me",
      envWith({ getUserProfile: async () => rpcOk(null) }),
      { headers: { Cookie: cookie } },
    );

    expect(response.status).toBe(401);
  });
});

describe("自己失効のときだけ Cookie を落とす", () => {
  const cookie = `${DEV_SESSION_COOKIE_NAME}=token-value`;

  function revokeWith(self: boolean, environment = "development") {
    // 送る Cookie の名前も環境に合わせる。production で開発用の名前を
    // 送ると読まれずに 401 で返り、Cookie の検証まで到達しない。
    const name = environment === "development" ? DEV_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
    return request(
      "/api/me/sessions/ses_x",
      envWith({ revokeSession: async () => rpcOk({ revoked: true, self }) }, environment),
      { method: "DELETE", headers: { Cookie: `${name}=token-value`, Origin: ORIGIN } },
    );
  }

  it("自分自身のセッションなら Cookie を落とす", async () => {
    // 落とさないと、失効済みの Cookie をブラウザが送り続け、
    // 次に 401 を踏むまで「ログアウトが効かなかった」ように見える。
    const response = await revokeWith(true);

    expect(response.headers.get("Set-Cookie")).toBe(
      `${DEV_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    );
  });

  it("別端末のセッションなら Cookie を落とさない", async () => {
    // revoked だけで判断すると、別端末を失効させた操作で自分がログアウトされる。
    const response = await revokeWith(false);

    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("production では Secure 付きで落とす", async () => {
    // 属性が 1 つでもずれるとブラウザは別の Cookie とみなし、元の Cookie が残る。
    const response = await revokeWith(true, "production");

    expect(response.headers.get("Set-Cookie")).toBe(
      `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
  });

  it("失効しなかった場合は Cookie を落とさない", async () => {
    const response = await request(
      "/api/me/sessions/ses_x",
      envWith({ revokeSession: async () => rpcOk({ revoked: false, self: true }) }),
      { method: "DELETE", headers: { Cookie: cookie, Origin: ORIGIN } },
    );

    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("auth-worker と同じ文字列を使う", () => {
    // 生成を共有している証拠。片方だけ属性が変わる事故を防ぐ。
    expect(buildClearedSessionCookie("development")).toBe(
      `${DEV_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    );
    // __Host- は Domain 属性を許さない。足すと __Host- を捨てたことになる。
    expect(buildClearedSessionCookie("production")).not.toContain("Domain");
  });
});

describe("セッション一覧", () => {
  it("auth-worker から受けた配列をそのまま返す", async () => {
    // この Worker は DTO を**加工せず**ブラウザへ渡す。つまり
    // SessionListItem に項目を足すと、それはそのまま利用者へ届く。
    // ipHash を契約から外してあるのはこのため（packages/contracts/src/identity.ts）。
    const items: SessionListItem[] = [
      {
        sessionId: "ses_1",
        createdAt: "2026-10-24T00:00:00.000Z",
        lastSeenAt: "2026-10-24T00:00:00.000Z",
        expiresAt: "2026-11-24T00:00:00.000Z",
        current: true,
        userAgent: "Mozilla/5.0",
      },
    ];

    const response = await request(
      "/api/me/sessions",
      envWith({ listSessions: async () => rpcOk(items) }),
      { headers: { Cookie: `${DEV_SESSION_COOKIE_NAME}=token-value` } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessions: items });
  });
});

describe("本番の route に合わせた /account 接頭辞（#106）", () => {
  const identity = { getUserProfile: async () => rpcOk(PROFILE) };
  const cookie = `${DEV_SESSION_COOKIE_NAME}=token-value`;

  it("接頭辞付きなら届く", async () => {
    const response = await rawRequest("/account/api/me", envWith(identity), {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
  });

  // この 4 件が回帰の本体。接頭辞を外すと本番では 404 になるが、
  // `wrangler dev` は dashboard を単独オリジンで起動するので手では気づけない。
  // 「接頭辞なしは 404」を固定しておかないと、誰かが外しても緑のままになる。
  it.each(["/health", "/api/me", "/api/me/sessions", "/api/me/grants"])(
    "接頭辞なしの %s は 404",
    async (path) => {
      const response = await rawRequest(path, envWith(identity as never), {
        headers: { Cookie: cookie },
      });

      expect(response.status).toBe(404);
    },
  );

  it("接頭辞なしでは RPC を呼ばない", async () => {
    // 404 になる前に Identity を叩いていたら、本番で無駄な RPC が出る。
    const response = await rawRequest(
      "/api/me",
      envWith({
        getUserProfile: () => neverCalled("getUserProfile"),
      } as never),
      { headers: { Cookie: cookie } },
    );

    expect(response.status).toBe(404);
  });
});

describe("同意済みアプリの一覧", () => {
  const cookie = `${DEV_SESSION_COOKIE_NAME}=token-value`;

  const GRANTS: GrantListItem[] = [
    {
      clientId: "u18-first-party",
      clientName: "u18 公式",
      logoUrl: null,
      scopes: ["openid", "profile"],
      grantedAt: "2026-10-24T00:00:00.000Z",
    },
  ];

  it("auth-worker から受けた配列をそのまま返す", async () => {
    // この Worker は DTO を加工せずブラウザへ渡す。つまり GrantListItem に
    // 項目を足すと、それはそのまま利用者へ届く。
    const response = await request(
      "/api/me/grants",
      envWith({ listGrants: async () => rpcOk(GRANTS) }),
      { headers: { Cookie: cookie } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ grants: GRANTS });
  });

  it("Cookie が無ければ RPC を呼ばずに 401", async () => {
    const response = await request(
      "/api/me/grants",
      envWith({ listGrants: () => neverCalled("listGrants") } as never),
    );

    expect(response.status).toBe(401);
  });

  it("GET には Origin 検証を課さない", async () => {
    const response = await request(
      "/api/me/grants",
      envWith({ listGrants: async () => rpcOk(GRANTS) }),
      { headers: { Cookie: cookie } },
    );

    expect(response.status).toBe(200);
  });

  it("RPC の失敗を HTTP ステータスへ翻訳する", async () => {
    const response = await request(
      "/api/me/grants",
      envWith({ listGrants: async () => rpcErr("unauthenticated", "session is not valid") }),
      { headers: { Cookie: cookie } },
    );

    expect(response.status).toBe(401);
  });
});

describe("同意の取り消し", () => {
  const cookie = `${DEV_SESSION_COOKIE_NAME}=token-value`;

  function revoke(env: Env, headers: Record<string, string>) {
    return request("/api/me/grants/u18-first-party", env, { method: "DELETE", headers });
  }

  it("同一オリジンなら RPC まで到達する", async () => {
    const response = await revoke(
      envWith({ revokeGrant: async () => rpcOk({ revoked: true, revokedTokenCount: 2 }) }),
      { Cookie: cookie, Origin: ORIGIN },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true, revokedTokenCount: 2 });
  });

  it("Origin が無ければ拒否する", async () => {
    // 状態を変える操作なので、セッション失効と同じ fail-closed にする。
    const response = await revoke(
      envWith({ revokeGrant: () => neverCalled("revokeGrant") } as never),
      { Cookie: cookie },
    );

    expect(response.status).toBe(403);
  });

  it("別オリジンからは拒否する", async () => {
    const response = await revoke(
      envWith({ revokeGrant: () => neverCalled("revokeGrant") } as never),
      { Cookie: cookie, Origin: "https://evil.example" },
    );

    expect(response.status).toBe(403);
  });

  it("Cookie が無ければ RPC を呼ばずに 401", async () => {
    const response = await revoke(
      envWith({ revokeGrant: () => neverCalled("revokeGrant") } as never),
      { Origin: ORIGIN },
    );

    expect(response.status).toBe(401);
  });

  it("同意していないクライアントなら 404", async () => {
    const response = await revoke(
      envWith({ revokeGrant: async () => rpcErr("not_found", "grant not found") }),
      { Cookie: cookie, Origin: ORIGIN },
    );

    expect(response.status).toBe(404);
  });

  it("Cookie を落とさない", async () => {
    // 同意の取り消しはセッションを切らない。操作者は引き続きログインしたまま。
    const response = await revoke(
      envWith({ revokeGrant: async () => rpcOk({ revoked: true, revokedTokenCount: 1 }) }),
      { Cookie: cookie, Origin: ORIGIN },
    );

    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("RPC が例外を投げても 503 に畳み込む", async () => {
    const response = await revoke(
      envWith({
        revokeGrant: () => {
          throw new Error("service binding is not available");
        },
      }),
      { Cookie: cookie, Origin: ORIGIN },
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("service binding");
  });
});

describe("/health は Identity まで確かめる（#44）", () => {
  it("Identity が ok なら 200", async () => {
    const response = await request(
      "/health",
      envWith({ ping: async () => rpcOk({ status: "ok", service: "u18-auth" } as const) }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      service: "u18-dashboard",
      checks: { identity: "ok" },
    });
  });

  it("Identity が degraded なら 503", async () => {
    // auth-worker は生きているが D1 へ届いていない。認証は成立しない。
    const response = await request(
      "/health",
      envWith({ ping: async () => rpcOk({ status: "degraded", service: "u18-auth" } as const) }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ checks: { identity: "degraded" } });
  });

  it("Identity へ届かなければ 503", async () => {
    // 以前はここが 200 だった。dashboard は認証機能のすべてを RPC に
    // 依存しているので、auth-worker が止まっていれば何も機能していない。
    const response = await request(
      "/health",
      envWith({
        ping: () => {
          throw new Error("service binding is not available");
        },
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ checks: { identity: "unreachable" } });
  });

  it("RPC がエラーを返しても 503", async () => {
    const response = await request(
      "/health",
      envWith({ ping: async () => rpcErr("internal", "sqlite: no such table: users") }),
    );

    expect(response.status).toBe(503);
    // 内部の事情を監視エンドポイントから漏らさない。
    expect(await response.text()).not.toContain("sqlite");
  });

  it("応答に機密情報を載せない", async () => {
    const response = await request(
      "/health",
      envWith({ ping: async () => rpcOk({ status: "ok", service: "u18-auth" } as const) }),
      { headers: { Cookie: `${DEV_SESSION_COOKIE_NAME}=token-value` } },
    );
    const body = await response.text();

    // 認証されていない要求から叩かれる経路なので、識別子を 1 つも返さない。
    expect(body).not.toContain("token-value");
    expect(body).not.toContain("@");
    expect(body).not.toContain("usr_");
  });

  it("Identity が応答しなければタイムアウトして 503", async () => {
    // 待ち続けると、監視から見て「落ちている」と「遅い」の区別が消える。
    // adapter 側の上限は 2 秒（identity.gateway.ts の PING_TIMEOUT_MS）。
    const response = await request(
      "/health",
      envWith({ ping: () => new Promise(() => undefined) }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ checks: { identity: "unreachable" } });
  }, 10_000);

  it("Cookie が無くても叩ける", async () => {
    // 監視は Cookie を持たない。
    const response = await request(
      "/health",
      envWith({ ping: async () => rpcOk({ status: "ok", service: "u18-auth" } as const) }),
    );

    expect(response.status).toBe(200);
  });
});
