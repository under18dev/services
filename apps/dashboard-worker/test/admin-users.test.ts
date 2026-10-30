import { DEV_SESSION_COOKIE_NAME, rpcErr, rpcOk } from "@u18/contracts";
import type { UserAdminSummary } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import {
  ADMIN_USERS_ACTION_PATH,
  ADMIN_USERS_PATH,
  ADMIN_USERS_SEARCH_PATH,
  PROFILE_PATH,
} from "../src/presentation/http/ui/asset-paths";
import { ORIGIN, envWith, executionContext, neverCalled } from "./helpers";

/**
 * 利用者の管理（`/account/admin/users`、#375 / #382）。
 *
 * ## ここでしか確かめられないこと
 *
 * **検索語が URL へ出ないこと。** 画面の作りの話なので、UseCase の
 * テスト（auth-worker 側）からは見えない。メールアドレスで引く画面なので、
 * クエリに出た瞬間に履歴・Referer・`csrf.ts` の拒否ログへ乗る。
 */

const COOKIE = `${DEV_SESSION_COOKIE_NAME}=token-value`;

const USER: UserAdminSummary = {
  id: "usr_01ABC",
  username: "taro",
  displayName: "山田 太郎",
  primaryEmail: "taro@example.com",
  emailVerified: true,
  status: "active",
  hasAdminFlag: false,
  createdAt: "2026-10-24T00:00:00.000Z",
};

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
  const response = await get(ADMIN_USERS_PATH, true, admin);
  const html = await response.text();
  return { cookie: cookieOf(response), csrf: csrfTokenOf(html) };
}

function postTo(path: string, admin: object, cookie: string, fields: Record<string, string>) {
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

function post(admin: object, cookie: string, fields: Record<string, string>) {
  return postTo(ADMIN_USERS_SEARCH_PATH, admin, cookie, fields);
}

function act(admin: object, cookie: string, fields: Record<string, string>) {
  return postTo(ADMIN_USERS_ACTION_PATH, admin, cookie, fields);
}

describe("GET /account/admin/users", () => {
  it("管理者でなければ 404 を返し、権限の話をしない", async () => {
    const response = await get(ADMIN_USERS_PATH, false, {
      listUsers: async () => rpcErr("not_found", "no such resource"),
    });

    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).not.toContain("権限");
    expect(html).not.toContain("管理者");
  });

  it("管理者には一覧が出る", async () => {
    const response = await get(ADMIN_USERS_PATH, true, {
      listUsers: async () => rpcOk({ users: [USER], nextCursor: null }),
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("山田 太郎");
    expect(html).toContain("taro@example.com");
    expect(html).toContain("usr_01ABC");
    // **キャッシュさせない。** 他人の個人情報が載っている。
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("GET は絞り込みを受け取らない（クエリを無視する）", async () => {
    // **検索語を URL に出さないための形。** クエリで引けると、
    // そちらを使う導線が生まれてメールアドレスが履歴に残る。
    let received: unknown;
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${ADMIN_USERS_PATH}?query=taro%40example.com`, {
        headers: { Cookie: COOKIE },
      }),
      envWith(session(true) as never, undefined, {
        listUsers: async (input: unknown) => {
          received = input;
          return rpcOk({ users: [], nextCursor: null });
        },
      } as never),
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(received).not.toHaveProperty("query");
  });

  it("続きがあるときだけ「続きを読む」が出る", async () => {
    const withMore = await get(ADMIN_USERS_PATH, true, {
      listUsers: async () => rpcOk({ users: [USER], nextCursor: "1700000000000:usr_01ABC" }),
    });
    expect(await withMore.text()).toContain("続きを読む");

    const noMore = await get(ADMIN_USERS_PATH, true, {
      listUsers: async () => rpcOk({ users: [USER], nextCursor: null }),
    });
    expect(await noMore.text()).not.toContain("続きを読む");
  });

  it("この画面は JS を読まない", async () => {
    const response = await get(ADMIN_USERS_PATH, true, {
      listUsers: async () => rpcOk({ users: [], nextCursor: null }),
    });

    // 障害対応で開く画面なので、JS が落ちても使えること。
    expect(await response.text()).not.toContain("<script");
  });

  it("メールアドレスをリンクにしない", async () => {
    const response = await get(ADMIN_USERS_PATH, true, {
      listUsers: async () => rpcOk({ users: [USER], nextCursor: null }),
    });

    // `mailto:` は管理画面から本人へ誤送信する導線になる。
    expect(await response.text()).not.toContain("mailto:");
  });

  it("停止中を「凍結」と言い切らない", async () => {
    const response = await get(ADMIN_USERS_PATH, true, {
      listUsers: async () => rpcOk({ users: [{ ...USER, status: "suspended" }], nextCursor: null }),
    });
    const html = await response.text();

    // `suspended` は運営の凍結と本人の退会（#318）の両方で付く。
    // この行からは区別できない。
    expect(html).toContain("停止中");
    expect(html).not.toContain("凍結");
  });
});

describe("POST /account/admin/users/search", () => {
  it("検索語は本文で渡り、URL には出ない", async () => {
    let received: { query?: string } | undefined;
    const admin = {
      listUsers: async (input: { query?: string }) => {
        received = input;
        return rpcOk({ users: [USER], nextCursor: null });
      },
    };
    const page = await openPage(admin);

    const response = await post(admin, page.cookie, {
      csrf_token: page.csrf,
      query: "taro@example.com",
    });

    expect(response.status).toBe(200);
    expect(received?.query).toBe("taro@example.com");
    // **リダイレクトしない。** PRG を挟むと検索語を次の GET へ運ぶ必要が出る。
    expect(response.headers.get("Location")).toBeNull();
    // 入力欄に残す（残さないと「続きを読む」が何の続きか分からない）。
    expect(await response.text()).toContain('value="taro@example.com"');
  });

  it("CSRF トークンが無ければ RPC を呼ばない", async () => {
    let calls = 0;
    const admin = {
      listUsers: (input: { cursor?: string }) => {
        // **1 回目は画面を開くための呼び出しなので数えない。**
        if (input.cursor !== undefined || calls > 0) calls += 1;
        if (calls > 1) return neverCalled("listUsers");
        return Promise.resolve(rpcOk({ users: [], nextCursor: null }));
      },
    };
    const page = await openPage(admin);
    const before = calls;

    const response = await post(admin, page.cookie, { query: "taro@example.com" });

    expect(response.status).toBe(200);
    // 弾いたあとも画面は描くので、一覧の取得だけは走る。
    // **検索語が渡っていないこと**が確かめたいこと。
    const html = await response.text();
    expect(html).toContain("画面を開き直して");
    expect(html).not.toContain('value="taro@example.com"');
    expect(calls).toBeGreaterThanOrEqual(before);
  });

  it("カーソルが壊れていたら、黙って先頭へ戻さない", async () => {
    // 先頭へ戻すと、送り続けても同じ 50 人が出る（終わらない一覧）。
    const admin = { listUsers: async () => rpcErr("invalid_input", "cursor is malformed") };
    const page = await openPage({ listUsers: async () => rpcOk({ users: [], nextCursor: null }) });

    const response = await post(admin, page.cookie, {
      csrf_token: page.csrf,
      cursor: "broken",
    });

    // `invalid_input` は adapter が `identity_unavailable` へ畳む。
    expect(response.status).toBe(503);
  });
});

describe("サイドバー", () => {
  it("管理者には「利用者」が出る", async () => {
    const html = await (await get(PROFILE_PATH, true, {})).text();
    expect(html).toContain(ADMIN_USERS_PATH);
    expect(html).toContain("利用者");
  });

  it("管理者でなければ出ない", async () => {
    const html = await (await get(PROFILE_PATH, false, {})).text();
    expect(html).not.toContain(ADMIN_USERS_PATH);
  });
});

describe("POST /account/admin/users/action", () => {
  const listOnly = { listUsers: async () => rpcOk({ users: [USER], nextCursor: null }) };

  it("停止は理由を添えて渡る", async () => {
    let received: { userId?: string; reason?: string } | undefined;
    const admin = {
      ...listOnly,
      suspendUser: async (input: { userId: string; reason: string }) => {
        received = input;
        return rpcOk({ revokedSessions: 2 });
      },
    };
    const page = await openPage(admin);

    const response = await act(admin, page.cookie, {
      csrf_token: page.csrf,
      user_id: USER.id,
      action: "suspend",
      reason: "abuse",
    });

    expect(response.status).toBe(200);
    expect(received?.userId).toBe(USER.id);
    // **`status` は 1 値しか持たない。** 理由を渡さないと記録が残らない。
    expect(received?.reason).toBe("abuse");
    const html = await response.text();
    expect(html).toContain("停止しました");
    // **「切ったから止まる」と書かない。** 止めた時点で通らなくなる。
    expect(html).not.toContain("切ったので");
  });

  it("理由を選ばないと RPC を呼ばない", async () => {
    let calls = 0;
    const admin = {
      ...listOnly,
      suspendUser: () => {
        calls += 1;
        return neverCalled("suspendUser");
      },
    };
    const page = await openPage(admin);

    const response = await act(admin, page.cookie, {
      csrf_token: page.csrf,
      user_id: USER.id,
      action: "suspend",
    });

    // 契約の `z.enum` が弾くと `invalid_input` =「障害」として出る。
    // 選び忘れは利用者の操作なので、やり直せる文で返す。
    expect(calls).toBe(0);
    expect(await response.text()).toContain("操作を選んでください");
  });

  it("CSRF トークンが無ければ RPC を呼ばない", async () => {
    let calls = 0;
    const admin = {
      ...listOnly,
      suspendUser: () => {
        calls += 1;
        return neverCalled("suspendUser");
      },
    };
    const page = await openPage(admin);

    const response = await act(admin, page.cookie, {
      user_id: USER.id,
      action: "suspend",
      reason: "abuse",
    });

    expect(calls).toBe(0);
    expect(await response.text()).toContain("画面を開き直して");
  });

  it("解除が通ると、またログインできると言う", async () => {
    const admin = { ...listOnly, reinstateUser: async () => rpcOk({}) };
    const page = await openPage(admin);

    const response = await act(admin, page.cookie, {
      csrf_token: page.csrf,
      user_id: USER.id,
      action: "reinstate",
    });

    expect(await response.text()).toContain("またログインできます");
  });

  it("セッションの失効は「ログインできなくなる」と書かない", async () => {
    const admin = { ...listOnly, revokeUserSessions: async () => rpcOk({ revokedSessions: 3 }) };
    const page = await openPage(admin);

    const response = await act(admin, page.cookie, {
      csrf_token: page.csrf,
      user_id: USER.id,
      action: "revoke_sessions",
    });

    const html = await response.text();
    // **止めていない。** 本人はログインし直せる。
    expect(html).toContain("ログインし直せます");
    expect(html).not.toContain("ログインできなくなります");
  });

  it("conflict は、やり直せる形の文で返す", async () => {
    const admin = { ...listOnly, suspendUser: async () => rpcErr("conflict", "not active") };
    const page = await openPage(admin);

    const response = await act(admin, page.cookie, {
      csrf_token: page.csrf,
      user_id: USER.id,
      action: "suspend",
      reason: "abuse",
    });

    const html = await response.text();
    expect(html).toContain("停止できませんでした");
    // 一覧ごと消さない。
    expect(html).toContain(USER.id);
  });

  it("再認証が要るときは、そう言う", async () => {
    const admin = {
      ...listOnly,
      suspendUser: async () => rpcErr("reauthentication_required", "stale"),
    };
    const page = await openPage(admin);

    const response = await act(admin, page.cookie, {
      csrf_token: page.csrf,
      user_id: USER.id,
      action: "suspend",
      reason: "abuse",
    });

    expect(await response.text()).toContain("ログインし直し");
  });

  it("自分の行には停止を出さない", async () => {
    // 守っているのは auth-worker（`conflict`）。**押せるのに断られる
    // 形にしない**ための表示上の配慮である。
    const self: typeof USER = { ...USER, id: "usr_admin" };
    const response = await get(ADMIN_USERS_PATH, true, {
      listUsers: async () => rpcOk({ users: [self], nextCursor: null }),
    });

    const html = await response.text();
    expect(html).toContain("自分のアカウントは停止できません");
    expect(html).not.toContain('value="suspend"');
  });

  it("deleted には操作を出さない", async () => {
    const response = await get(ADMIN_USERS_PATH, true, {
      listUsers: async () =>
        rpcOk({ users: [{ ...USER, status: "deleted" as const }], nextCursor: null }),
    });

    const html = await response.text();
    expect(html).toContain("個人情報を削除済み");
    expect(html).not.toContain('value="reinstate"');
  });
});
