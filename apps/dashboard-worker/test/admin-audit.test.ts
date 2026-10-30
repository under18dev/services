import { DEV_SESSION_COOKIE_NAME, rpcErr, rpcOk } from "@u18/contracts";
import type { AuditLogEntryAdmin } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import {
  ADMIN_AUDIT_PATH,
  ADMIN_AUDIT_SEARCH_PATH,
  PROFILE_PATH,
} from "../src/presentation/http/ui/asset-paths";
import { ORIGIN, envWith, executionContext } from "./helpers";

/**
 * 監査ログの閲覧（`/account/admin/audit`、#375 / #382）。
 *
 * `admin-users.test.ts` と対になる。ここでしか確かめられないのは
 * **`metadata` / `ipHash` が画面に出ること**（`SessionListItem` が
 * 意図的に外している値を、この画面だけが出す）と、**0 件なら表を
 * 描かないこと**（#391 で固定した形をこの画面でも守っているか）。
 */

const COOKIE = `${DEV_SESSION_COOKIE_NAME}=token-value`;

function session(isAdmin: boolean) {
  return {
    getSession: async () => rpcOk({ id: "ses_1", userId: "usr_admin", isAdmin }),
    getUserProfile: async () =>
      rpcOk({
        id: "usr_admin",
        username: "admin",
        displayName: "Admin",
        email: "admin@example.com",
        emailVerified: true,
        status: "active" as const,
        isAdmin,
        createdAt: "2026-10-24T00:00:00.000Z",
      }),
    listPasskeys: async () => rpcOk([]),
    listSessions: async () => rpcOk([]),
    listGrants: async () => rpcOk([]),
  };
}

const ENTRY: AuditLogEntryAdmin = {
  id: "aud_1",
  event: "ops.user.suspended",
  userId: "usr_target",
  actor: "dashboard-worker",
  outcome: "success",
  reason: null,
  metadata: { reason: "abuse", actorUserId: "usr_admin" },
  ipHash: "deadbeef",
  userAgent: null,
  createdAt: "2026-10-30T00:00:00.000Z",
};

function get(path: string, isAdmin: boolean, admin: object) {
  return createApp().fetch(
    new Request(`${ORIGIN}${path}`, { headers: { Cookie: COOKIE } }),
    envWith(session(isAdmin) as never, undefined, admin as never),
    executionContext(),
  );
}

function csrfTokenOf(html: string): string {
  const match = /name="csrf_token" value="([^"]+)"/.exec(html);
  if (match?.[1] === undefined) throw new Error("CSRF トークンが描画されていない");
  return match[1];
}

function cookieOf(response: Response): string {
  const pairs = response.headers.getSetCookie().map((raw) => raw.split(";")[0] ?? "");
  return [COOKIE, ...pairs].join("; ");
}

async function openPage(admin: object): Promise<{ cookie: string; csrf: string }> {
  const response = await get(ADMIN_AUDIT_PATH, true, admin);
  const html = await response.text();
  return { cookie: cookieOf(response), csrf: csrfTokenOf(html) };
}

function post(admin: object, cookie: string, fields: Record<string, string>) {
  return createApp().fetch(
    new Request(`${ORIGIN}${ADMIN_AUDIT_SEARCH_PATH}`, {
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

describe("GET /account/admin/audit", () => {
  it("管理者でなければ 404 を返し、権限の話をしない", async () => {
    const response = await get(ADMIN_AUDIT_PATH, false, {
      listAuditLogs: async () => rpcErr("not_found", "no such resource"),
    });

    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).not.toContain("権限");
    expect(html).not.toContain("管理者");
  });

  it("管理者には表が出る", async () => {
    const response = await get(ADMIN_AUDIT_PATH, true, {
      listAuditLogs: async () => rpcOk({ entries: [ENTRY], nextCursor: null }),
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<table");
    expect(html).toContain("ops.user.suspended");
  });

  it("ipHash と metadata が画面に出る", async () => {
    const response = await get(ADMIN_AUDIT_PATH, true, {
      listAuditLogs: async () => rpcOk({ entries: [ENTRY], nextCursor: null }),
    });

    const html = await response.text();
    expect(html).toContain("deadbeef");
    expect(html).toContain("abuse");
  });

  it("0 件のときは表を描かない", async () => {
    const response = await get(ADMIN_AUDIT_PATH, true, {
      listAuditLogs: async () => rpcOk({ entries: [], nextCursor: null }),
    });

    const html = await response.text();
    expect(html).not.toContain("<table");
    expect(html).toContain("一致する記録はありません");
  });

  it("続きがあるときだけ「続きを読む」が出る", async () => {
    const withMore = await get(ADMIN_AUDIT_PATH, true, {
      listAuditLogs: async () => rpcOk({ entries: [ENTRY], nextCursor: "1700000000000:aud_1" }),
    });
    expect(await withMore.text()).toContain("続きを読む");

    const noMore = await get(ADMIN_AUDIT_PATH, true, {
      listAuditLogs: async () => rpcOk({ entries: [ENTRY], nextCursor: null }),
    });
    expect(await noMore.text()).not.toContain("続きを読む");
  });

  it("GET は絞り込みを受け取らない（クエリを無視する）", async () => {
    let received: unknown;
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${ADMIN_AUDIT_PATH}?event=ops.user.suspended&user_id=usr_target`, {
        headers: { Cookie: COOKIE },
      }),
      envWith(session(true) as never, undefined, {
        listAuditLogs: async (input: unknown) => {
          received = input;
          return rpcOk({ entries: [], nextCursor: null });
        },
      } as never),
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(received).not.toHaveProperty("event");
    expect(received).not.toHaveProperty("userId");
  });

  it("この画面は JS を読まない", async () => {
    const response = await get(ADMIN_AUDIT_PATH, true, {
      listAuditLogs: async () => rpcOk({ entries: [], nextCursor: null }),
    });

    expect(await response.text()).not.toContain("<script");
  });
});

describe("POST /account/admin/audit/search", () => {
  const listOnly = { listAuditLogs: async () => rpcOk({ entries: [ENTRY], nextCursor: null }) };

  it("絞り込みは本文で渡り、URL には出ない", async () => {
    let received: { event?: string; userId?: string; outcome?: string } | undefined;
    const admin = {
      listAuditLogs: async (input: { event?: string; userId?: string; outcome?: string }) => {
        received = input;
        return rpcOk({ entries: [ENTRY], nextCursor: null });
      },
    };
    const page = await openPage(admin);

    const response = await post(admin, page.cookie, {
      csrf_token: page.csrf,
      event: "ops.user.suspended",
      user_id: "usr_target",
      outcome: "success",
    });

    expect(response.status).toBe(200);
    expect(received?.event).toBe("ops.user.suspended");
    expect(received?.userId).toBe("usr_target");
    expect(received?.outcome).toBe("success");
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toContain('value="ops.user.suspended"');
  });

  it("outcome を指定しなければ渡さない", async () => {
    let received: { outcome?: string } | undefined;
    const admin = {
      listAuditLogs: async (input: { outcome?: string }) => {
        received = input;
        return rpcOk({ entries: [], nextCursor: null });
      },
    };
    const page = await openPage(admin);

    await post(admin, page.cookie, { csrf_token: page.csrf, outcome: "" });

    expect(received?.outcome).toBeUndefined();
  });

  it("CSRF トークンが無ければ RPC を呼ばない", async () => {
    let calls = 0;
    const admin = {
      listAuditLogs: (input: { event?: string }) => {
        if (input.event !== undefined) calls += 1;
        return Promise.resolve(rpcOk({ entries: [], nextCursor: null }));
      },
    };
    const page = await openPage(admin);

    const response = await post(admin, page.cookie, { event: "x" });

    expect(calls).toBe(0);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("画面を開き直して");
  });

  it("管理者でなくなっていたら 404", async () => {
    const admin = { listAuditLogs: async () => rpcErr("not_found", "no such resource") };
    const page = await openPage(listOnly);

    const response = await post(admin, page.cookie, { csrf_token: page.csrf, event: "x" });

    expect(response.status).toBe(404);
  });
});

describe("サイドバー", () => {
  it("管理者には「監査ログ」が出る", async () => {
    const html = await (await get(PROFILE_PATH, true, {})).text();
    expect(html).toContain(ADMIN_AUDIT_PATH);
    expect(html).toContain("監査ログ");
  });

  it("管理者でなければ出ない", async () => {
    const html = await (await get(PROFILE_PATH, false, {})).text();
    expect(html).not.toContain(ADMIN_AUDIT_PATH);
  });
});
