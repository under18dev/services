import { DEV_SESSION_COOKIE_NAME, rpcErr, rpcOk } from "@u18/contracts";
import { scopeLabel } from "@u18/web-ui";
import type { GrantListItem, PasskeySummary, SessionListItem, UserProfile } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE_PATH, createApp } from "../src/presentation/http/app";
import {
  GRANTS_PATH,
  OVERVIEW_PATH,
  SESSIONS_PATH,
  STYLESHEET_PATH,
} from "../src/presentation/http/ui/asset-paths";
import { ORIGIN, envWith, executionContext, neverCalled } from "./helpers";

/**
 * アカウント管理画面（#9）。
 *
 * この画面は **JS 無しで成立する**。ここで確かめるのは
 * 「HTML が出ること」ではなく、**出てはいけないものが出ていないこと**と
 * **他の経路と同じ扱いになっていること**である。
 */

const COOKIE = `${DEV_SESSION_COOKIE_NAME}=token-value`;

const PROFILE: UserProfile = {
  id: "usr_test",
  username: "taro",
  displayName: "Taro",
  email: "taro@example.com",
  emailVerified: true,
  status: "active",
  isAdmin: false,
  createdAt: "2026-10-24T00:00:00.000Z",
};

async function get(path: string, identity: object, init: RequestInit = {}): Promise<Response> {
  return await createApp().fetch(
    new Request(`${ORIGIN}${path}`, init),
    envWith(identity as never),
    executionContext(),
  );
}

function withCookie(path: string, identity: object): Promise<Response> {
  return get(path, identity, { headers: { Cookie: COOKIE } });
}

const FULL_IDENTITY = {
  getUserProfile: async () => rpcOk(PROFILE),
  listPasskeys: async () => rpcOk([] as PasskeySummary[]),
  listSessions: async () => rpcOk([] as SessionListItem[]),
  listGrants: async () => rpcOk([] as GrantListItem[]),
};

const PAGES = [OVERVIEW_PATH, SESSIONS_PATH, GRANTS_PATH];

describe("3 つの画面が HTML を返す", () => {
  it.each(PAGES)("%s", async (path) => {
    const response = await withCookie(path, FULL_IDENTITY);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });

  it("ナビの行き先がすべて実在する", async () => {
    // ナビに書いたパスと、実際に登録したルートがずれると 404 を踏む。
    // 画面から `href` を抜き出して、全部引けることを確かめる。
    const html = await (await withCookie(OVERVIEW_PATH, FULL_IDENTITY)).text();
    const navHrefs = [...html.matchAll(/<nav class="nav">(.*?)<\/nav>/gs)]
      .flatMap((nav) => [...(nav[1] ?? "").matchAll(/href="([^"]+)"/g)])
      .map((m) => m[1] as string);

    expect(navHrefs).toEqual(PAGES);

    for (const href of navHrefs) {
      const response = await withCookie(href, FULL_IDENTITY);
      expect(response.status, `ナビの ${href} が引けない`).toBe(200);
    }
  });
});

describe("末尾スラッシュの有無で 404 にしない", () => {
  // Hono は既定（`strict: true`）で `/account` と `/account/` を別物として
  // 扱う。**画面の入口なので、利用者が URL バーに打った側が登録されて
  // いなければ踏めない。** `createApp()` の `strict: false` がこれを同一視する。
  //
  // services-6f が #197 で見つけた。こちらの実装は `.route()` 経由だったので
  // 生きているのは逆側（`/account` が 200 で `/account/` が 404）だった。
  // 片側しか試していなければ、どちらの実装でも「通る」と読めてしまう。
  it.each([
    [OVERVIEW_PATH, `${OVERVIEW_PATH}/`],
    [SESSIONS_PATH, `${SESSIONS_PATH}/`],
    [GRANTS_PATH, `${GRANTS_PATH}/`],
  ])("%s と %s が同じ扱いになる", async (withoutSlash, withSlash) => {
    const a = await withCookie(withoutSlash, FULL_IDENTITY);
    const b = await withCookie(withSlash, FULL_IDENTITY);

    expect(a.status).toBe(200);
    expect(b.status, `${withSlash} が 404`).toBe(200);
  });
});

describe("参照しているスタイルシートを自分で配信している", () => {
  // **この Worker 単体で成立すること。** `<link href>` を手で書くと、
  // 配信ルート側だけ直して参照が古いまま、という形で 404 になる。
  // ブラウザは素の HTML を出すだけで、型検査もテストも何も言わない。
  it.each(PAGES)("%s の <link> が指す先が 200 を返す", async (path) => {
    const html = await (await withCookie(path, FULL_IDENTITY)).text();
    const href = /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1];

    expect(href, `${path} に stylesheet の link が無い`).toBe(STYLESHEET_PATH);

    const css = await get(href as string, {});
    expect(css.status).toBe(200);
    expect(css.headers.get("Content-Type")).toContain("text/css");
    expect(await css.text()).toContain("--accent");
  });
});

describe("Cookie が無ければ RPC を呼ばずに 401 とログイン導線", () => {
  const identity = {
    getUserProfile: () => neverCalled("getUserProfile"),
    listPasskeys: () => neverCalled("listPasskeys"),
    listSessions: () => neverCalled("listSessions"),
    listGrants: () => neverCalled("listGrants"),
  };

  it.each(PAGES)("%s", async (path) => {
    const response = await get(path, identity);

    // 200 で「ログインしてください」と書いた HTML を返すと、
    // 外形監視からは正常に見える。JSON 経路と同じ 401 にする。
    expect(response.status).toBe(401);

    const html = await response.text();
    // ログイン画面は auth-worker 側。接頭辞を付けるとこの Worker へ戻ってくる。
    // 戻り先のクエリが付くので前方一致で見る。
    expect(html).toMatch(/href="\/login(\?|")/);
    expect(html).not.toContain(`href="${ACCOUNT_BASE_PATH}/login"`);
  });

  it("行き先の無い画面ではナビを出さない", async () => {
    // 出すと、押すたびに同じ 401 へ戻る。
    const html = await (await get(OVERVIEW_PATH, identity)).text();

    expect(html).not.toContain('class="nav"');
  });
});

describe("セッションが無効なら 401", () => {
  it("getProfile が null を返したとき", async () => {
    const response = await withCookie(OVERVIEW_PATH, {
      getUserProfile: async () => rpcOk(null),
      listPasskeys: async () => rpcOk([] as PasskeySummary[]),
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("ログインが必要です");
  });
});

describe("Identity が使えないときは 503", () => {
  it.each([
    [OVERVIEW_PATH, "getUserProfile"],
    [SESSIONS_PATH, "listSessions"],
    [GRANTS_PATH, "listGrants"],
  ])("%s", async (path, method) => {
    const response = await withCookie(path, {
      ...FULL_IDENTITY,
      [method]: async () => rpcErr("internal", "sqlite: no such table: sessions"),
    });

    expect(response.status).toBe(503);

    const html = await response.text();
    // auth-worker 側の事情を画面へ出さない。構成を推測する材料になる。
    expect(html).not.toContain("sqlite");
  });
});

describe("利用者が決められない文字列をそのまま埋め込まない", () => {
  // User-Agent も clientName も**攻撃者が自分で値を決められる**。
  // hono/jsx のエスケープに任せており、`raw()` を使っていないことの固定。
  const XSS = '"><script>alert(1)</script>';

  it("セッションの User-Agent", async () => {
    const session: SessionListItem = {
      sessionId: "ses_1",
      createdAt: "2026-10-24T00:00:00.000Z",
      lastSeenAt: "2026-10-24T00:00:00.000Z",
      expiresAt: "2026-11-24T00:00:00.000Z",
      current: true,
      userAgent: XSS,
    };

    const html = await (
      await withCookie(SESSIONS_PATH, { listSessions: async () => rpcOk([session]) })
    ).text();

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("連携アプリの名前", async () => {
    // クライアント名は登録した第三者が自由に付けられる。
    const grant: GrantListItem = {
      clientId: "cli_1",
      clientName: XSS,
      logoUrl: "https://evil.example/pixel.png",
      scopes: ["openid"],
      grantedAt: "2026-10-24T00:00:00.000Z",
    };

    const html = await (
      await withCookie(GRANTS_PATH, { listGrants: async () => rpcOk([grant]) })
    ).text();

    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("連携アプリのロゴを読み込まない", () => {
  it("logoUrl が HTML に現れない", async () => {
    // CSP の img-src は第三者ホストを許していない（@u18/web-ui）。
    // 出すと「この画面を開いた事実」が第三者のサーバーへ伝わる。
    const grant: GrantListItem = {
      clientId: "cli_1",
      clientName: "Example App",
      logoUrl: "https://evil.example/pixel.png",
      scopes: ["openid"],
      grantedAt: "2026-10-24T00:00:00.000Z",
    };

    const html = await (
      await withCookie(GRANTS_PATH, { listGrants: async () => rpcOk([grant]) })
    ).text();

    expect(html).toContain("Example App");
    expect(html).not.toContain("evil.example");
  });
});

describe("画面には CSP が付く", () => {
  it.each(PAGES)("%s", async (path) => {
    const response = await withCookie(path, FULL_IDENTITY);
    const csp = response.headers.get("Content-Security-Policy");

    expect(csp, `${path} に CSP が無い`).toBeTruthy();
    // インラインを許さないこと。許すと XSS の緩和がほぼ無くなる。
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe("Referrer-Policy を no-referrer にしない", () => {
  /**
   * Fetch 仕様では、referrer policy が参照元を落とすとき**ナビゲーション
   * 要求の `Origin` も `null` になる**。自分のページから出した form 送信が
   * `Origin: null` で届き、Origin 検証に落ちる。auth-worker が本番でこれを
   * 踏み、ログイン・新規登録・ログアウトが全滅した（#226）。
   *
   * **この Worker にはまだ form POST が無い。** だからこのテストは
   * 「いま壊れていること」ではなく、**#208（JS 無しで他端末を切る）を
   * 入れた瞬間に同じ障害を踏むこと**を防いでいる。そのとき
   * `@u18/web-ui` の `page-headers.ts` を読んだ人は #226 で直っていると
   * 思うので、ここで止める以外に気づく機会が無い。
   */
  it.each(PAGES)("%s", async (path) => {
    const response = await withCookie(path, FULL_IDENTITY);

    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  it("401 の応答にも付く", async () => {
    // 画面だけに付けても、ログインへ誘導する 401 の HTML から出した
    // form 送信は同じ問題を踏む。全体ミドルウェアで付けている以上
    // 付いているはずで、経路を 1 つに保てているかの確認でもある。
    const response = await get(OVERVIEW_PATH, {
      getUserProfile: () => neverCalled("getUserProfile"),
      listPasskeys: () => neverCalled("listPasskeys"),
      listSessions: () => neverCalled("listSessions"),
      listGrants: () => neverCalled("listGrants"),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  });
});

describe("0 件のときに空の一覧を出さない", () => {
  it.each([
    [OVERVIEW_PATH, "登録されているパスキーはありません"],
    [GRANTS_PATH, "連携を許可したアプリはありません"],
  ])("%s", async (path, message) => {
    const html = await (await withCookie(path, FULL_IDENTITY)).text();

    expect(html).toContain(message);
  });
});

describe("実装側の語を画面に出さない", () => {
  it("User-Agent は要約と原文の両方を出す", async () => {
    // 要約だけだと「当たっているか」を利用者が確かめられない。
    // 原文だけだと 1 件が 2 行になり、拾い読みができない。
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
    const session: SessionListItem = {
      sessionId: "ses_1",
      createdAt: "2026-10-24T00:00:00.000Z",
      lastSeenAt: "2026-10-24T00:00:00.000Z",
      expiresAt: "2026-11-24T00:00:00.000Z",
      current: false,
      userAgent: ua,
    };

    const html = await (
      await withCookie(SESSIONS_PATH, { listSessions: async () => rpcOk([session]) })
    ).text();

    expect(html).toContain("Chrome / macOS");
    expect(html).toContain("AppleWebKit/537.36");
  });

  it("要約できない User-Agent は原文を見出しにする（二重に出さない）", async () => {
    const session: SessionListItem = {
      sessionId: "ses_1",
      createdAt: "2026-10-24T00:00:00.000Z",
      lastSeenAt: "2026-10-24T00:00:00.000Z",
      expiresAt: "2026-11-24T00:00:00.000Z",
      current: false,
      userAgent: "curl/8.7.1",
    };

    const html = await (
      await withCookie(SESSIONS_PATH, { listSessions: async () => rpcOk([session]) })
    ).text();

    expect(html.match(/curl\/8\.7\.1/g)).toHaveLength(1);
  });

  it("Passkey の deviceType を生のまま出さない", async () => {
    // `cross-platform` は実装側の語。画面に出しても利用者には伝わらない。
    const passkey: PasskeySummary = {
      id: "pk_1",
      label: null,
      deviceType: "cross-platform",
      createdAt: "2026-10-24T00:00:00.000Z",
      lastUsedAt: null,
    };

    const html = await (
      await withCookie(OVERVIEW_PATH, {
        getUserProfile: async () => rpcOk(PROFILE),
        listPasskeys: async () => rpcOk([passkey]),
      })
    ).text();

    expect(html).not.toContain("cross-platform");
    expect(html).toContain("名前のないパスキー");
    expect(html).toContain("他の端末・セキュリティキー");
  });

  it("scope は同意画面と同じ文言で出す", async () => {
    // 許可したときと取り消すときで言葉が違うと、利用者は
    // 「同じものを取り消そうとしている」と確信できない。
    const grant: GrantListItem = {
      clientId: "cli_1",
      clientName: "Example App",
      logoUrl: null,
      scopes: ["profile", "wallet:write"],
      grantedAt: "2026-10-24T00:00:00.000Z",
    };

    const html = await (
      await withCookie(GRANTS_PATH, { listGrants: async () => rpcOk([grant]) })
    ).text();

    expect(html).toContain(scopeLabel("profile"));
    // 知らない scope は畳まずコードのまま出す。「その他」にすると、
    // 何を許可しているか分からないものが画面から消える。
    expect(html).toContain("wallet:write");
  });
});
