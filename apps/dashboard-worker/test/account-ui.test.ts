import { DEV_SESSION_COOKIE_NAME, rpcErr, rpcOk } from "@u18/contracts";
import type { GrantListItem, PasskeySummary, SessionListItem, UserProfile } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE_PATH, createApp } from "../src/presentation/http/app";
import { ORIGIN, envWith, executionContext } from "./helpers";

/**
 * アカウント管理の画面。
 *
 * API（`api.test.ts`）が「Cookie を読み、Origin を確かめ、RPC の失敗を
 * ステータスへ翻訳する」を持っているので、ここは**画面として成立して
 * いるか**だけを見る。
 */

const PROFILE: UserProfile = {
  id: "usr_test",
  username: "taro",
  displayName: "Taro",
  email: "taro@example.com",
  emailVerified: true,
  status: "active",
  createdAt: "2026-10-24T00:00:00.000Z",
  isAdmin: false,
};

const SESSION: SessionListItem = {
  sessionId: "ses_1",
  createdAt: "2026-10-24T00:00:00.000Z",
  lastSeenAt: "2026-10-25T00:00:00.000Z",
  expiresAt: "2026-10-25T12:00:00.000Z",
  current: true,
  userAgent: "curl/8.7.1",
};

const PASSKEY: PasskeySummary = {
  id: "pk_1",
  label: "MacBook",
  deviceType: "platform",
  createdAt: "2026-10-24T00:00:00.000Z",
  lastUsedAt: null,
};

const GRANT: GrantListItem = {
  clientId: "client-abc",
  clientName: "サンプルアプリ",
  logoUrl: "https://evil.example/logo.png",
  scopes: ["openid", "profile"],
  grantedAt: "2026-10-24T00:00:00.000Z",
};

async function open(path: string, identity: object, cookie = true): Promise<Response> {
  const headers = cookie ? { Cookie: `${DEV_SESSION_COOKIE_NAME}=token-value` } : {};
  return await createApp().fetch(
    new Request(`${ORIGIN}${ACCOUNT_BASE_PATH}${path}`, { headers }),
    envWith(identity),
    executionContext(),
  );
}

describe("プロフィール", () => {
  const identity = { getUserProfile: async () => rpcOk(PROFILE) };

  it("自分の情報が出る", async () => {
    const response = await open("/", identity);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");

    const html = await response.text();
    expect(html).toContain("Taro");
    expect(html).toContain("taro@example.com");
    expect(html).toContain("確認済み");
  });

  it("セッションが無効なら（RPC は成功でも null）ログインへ送る", async () => {
    // getUserProfile は「存在しないこと自体はエラーではない」ので
    // ok のまま null を返す。画面からは未ログインと区別がつかない。
    const response = await open("/", { getUserProfile: async () => rpcOk(null) });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });
});

describe("ログイン中の端末", () => {
  it("一覧が出て、このデバイスが分かる", async () => {
    const html = await (
      await open("/sessions", { listSessions: async () => rpcOk([SESSION]) })
    ).text();
    expect(html).toContain("この端末");
    expect(html).toContain("2026-10-24");
  });

  it("1 つも無ければその旨が出る", async () => {
    const html = await (await open("/sessions", { listSessions: async () => rpcOk([]) })).text();
    expect(html).toContain("ログイン中の端末はありません");
  });
});

describe("パスキー", () => {
  it("一覧が出る", async () => {
    const html = await (
      await open("/passkeys", { listPasskeys: async () => rpcOk([PASSKEY]) })
    ).text();
    expect(html).toContain("MacBook");
    expect(html).toContain("未使用");
  });

  it("最後の 1 本も削除できると案内する（できないと書かない）", async () => {
    const html = await (
      await open("/passkeys", { listPasskeys: async () => rpcOk([PASSKEY]) })
    ).text();
    // 決定 2 によりメール OTP が常に残るので、最後の 1 本も削除できる。
    expect(html).toContain("最後の 1 本も削除できます");
  });
});

describe("連携アプリ", () => {
  const identity = { listGrants: async () => rpcOk([GRANT]) };

  it("一覧と scope が出る", async () => {
    const html = await (await open("/grants", identity)).text();
    expect(html).toContain("サンプルアプリ");
    expect(html).toContain("openid profile");
  });

  it("logoUrl を読み込まない（この画面を開いた事実を第三者へ渡さない）", async () => {
    const html = await (await open("/grants", identity)).text();
    expect(html).not.toContain("https://evil.example/logo.png");
  });
});

describe("全画面に共通して効くもの", () => {
  const cases = [
    ["/", { getUserProfile: async () => rpcOk(PROFILE) }],
    ["/sessions", { listSessions: async () => rpcOk([SESSION]) }],
    ["/passkeys", { listPasskeys: async () => rpcOk([PASSKEY]) }],
    ["/grants", { listGrants: async () => rpcOk([GRANT]) }],
  ] as const;

  it.each(cases)("%s は共有キャッシュに載らない", async (path, identity) => {
    const response = await open(path, identity);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each(cases)("%s に CSP が掛かっている", async (path, identity) => {
    const csp = (await open(path, identity)).headers.get("Content-Security-Policy");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'none'");
  });

  it.each(cases)("%s は JS を要求しない", async (path, identity) => {
    const html = await (await open(path, identity)).text();
    expect(html).not.toContain("<script");
  });

  it.each(cases)("%s から他の画面へ行ける", async (path, identity) => {
    const html = await (await open(path, identity)).text();
    // 現在地は <strong> になって href に出ないので、どの画面でも
    // 現在地になりえない `/account/nfc` で見る。
    expect(html).toContain('href="/account/nfc"');
  });
});

describe("失敗の扱いは全画面で揃っている", () => {
  const unauth = { kind: "unauthenticated" as const };
  const down = { kind: "internal" as const };

  const paths = ["/", "/sessions", "/passkeys", "/grants"] as const;
  const method = {
    "/": "getUserProfile",
    "/sessions": "listSessions",
    "/passkeys": "listPasskeys",
    "/grants": "listGrants",
  } as const;

  it.each(paths)("%s は未ログインでログインへ送る（JSON を見せない）", async (path) => {
    const response = await open(
      path,
      { [method[path]]: async () => rpcErr(unauth.kind, "session is not valid") },
      false,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });

  it.each(paths)("%s は auth-worker 障害でログインへ送らない", async (path) => {
    // 送ると、ログインも同じ Worker が受けているので利用者が
    // 延々とログインし直す羽目になる。
    const response = await open(path, {
      [method[path]]: async () => rpcErr(down.kind, "sqlite: no such table"),
    });
    expect(response.status).toBe(503);
  });
});
