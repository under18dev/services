import { DEV_SESSION_COOKIE_NAME, rpcOk } from "@u18/contracts";
import type { GrantListItem, PasskeySummary, SessionListItem, UserProfile } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import {
  GRANTS_PATH,
  ISLAND_PATH,
  OVERVIEW_PATH,
  SESSIONS_PATH,
} from "../src/presentation/http/ui/asset-paths";
import { ORIGIN, envWith, executionContext } from "./helpers";

/**
 * 取り消し操作のアイランドと、サーバーが返す HTML の噛み合わせ（#9）。
 *
 * **ボタンそのものはアイランドが作る**ので、ここで確かめるのは
 * 「アイランドが掴むための目印が出ていること」と「JS が無いときに
 * 何も壊れていないこと」である。
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

const SESSION: SessionListItem = {
  sessionId: "ses_1",
  createdAt: "2026-10-24T00:00:00.000Z",
  lastSeenAt: "2026-10-24T00:00:00.000Z",
  expiresAt: "2026-11-24T00:00:00.000Z",
  current: true,
  userAgent: "Mozilla/5.0",
};

const PASSKEY: PasskeySummary = {
  id: "pk_1",
  label: "MacBook",
  deviceType: "platform",
  createdAt: "2026-10-24T00:00:00.000Z",
  lastUsedAt: null,
};

const GRANT: GrantListItem = {
  clientId: "cli_1",
  clientName: "Example App",
  logoUrl: null,
  scopes: ["openid"],
  grantedAt: "2026-10-24T00:00:00.000Z",
};

const IDENTITY = {
  getUserProfile: async () => rpcOk(PROFILE),
  listPasskeys: async () => rpcOk([PASSKEY]),
  listSessions: async () => rpcOk([SESSION]),
  listGrants: async () => rpcOk([GRANT]),
};

async function html(path: string, identity: object = IDENTITY): Promise<string> {
  const response = await createApp().fetch(
    new Request(`${ORIGIN}${path}`, { headers: { Cookie: COOKIE } }),
    envWith(identity as never),
    executionContext(),
  );
  return await response.text();
}

describe("アイランドが掴む目印が出ている", () => {
  it.each([
    [OVERVIEW_PATH, 'data-passkey-id="pk_1"'],
    [SESSIONS_PATH, 'data-session-id="ses_1"'],
    [GRANTS_PATH, 'data-grant-client-id="cli_1"'],
  ])("%s", async (path, marker) => {
    expect(await html(path)).toContain(marker);
  });

  it("自分自身のセッションが区別できる", async () => {
    // 自分を切るとサーバーが Cookie を落とすので、アイランドは
    // 一覧を触らずログイン画面へ送る必要がある。区別が付かないと
    // 「ログアウトしたのに画面はログイン中のまま」になる。
    expect(await html(SESSIONS_PATH)).toContain('data-current="true"');

    const other = await html(SESSIONS_PATH, {
      listSessions: async () => rpcOk([{ ...SESSION, current: false }]),
    });
    expect(other).toContain('data-current="false"');
  });
});

describe("JS を読み込む画面と、その配信", () => {
  it.each([OVERVIEW_PATH, SESSIONS_PATH, GRANTS_PATH])(
    "%s が参照する JS が引ける",
    async (path) => {
      const page = await html(path);
      expect(page).toContain(`src="${ISLAND_PATH}"`);

      const script = await createApp().fetch(
        new Request(`${ORIGIN}${ISLAND_PATH}`),
        envWith({} as never),
        executionContext(),
      );

      expect(script.status).toBe(200);
      expect(script.headers.get("Content-Type")).toContain("text/javascript");
      // 空のバンドルが配信されていないこと。ビルドが走らないまま
      // 固定値が入っていると、ボタンが出ないだけで何も言わない。
      expect((await script.text()).length).toBeGreaterThan(1000);
    },
  );
});

describe("URL に内容ハッシュが入る（#211）", () => {
  /**
   * **HTML に実際に書かれた URL を取りに行く。**
   *
   * 定数を 2 回使って突き合わせると「定数が自分自身と一致する」しか
   * 見ていない。ページが書く文字列から抜いて引くと、`asset-paths.ts` と
   * 配信ルートの間が本当に繋がっていることになる。
   *
   * ハッシュが入っていることも見る。**外れても画面は動く**（URL が
   * 固定に戻るだけ）ので、ここが唯一それに気づく場所である。外れると
   * `immutable` と組み合わさって、**内容を変えてもブラウザが 1 年
   * 古いものを使い続ける** —— #211 で消した窓が桁違いの長さで戻る。
   */
  const urlsIn = (page: string): string[] =>
    [...page.matchAll(/(?:src|href)="([^"]*\/ui\/[^"]*)"/g)].map((match) => match[1] ?? "");

  it.each([OVERVIEW_PATH, SESSIONS_PATH, GRANTS_PATH])("%s が参照する URL", async (path) => {
    const urls = urlsIn(await html(path));
    expect(urls.length, "アセットを 1 つも参照していない").toBeGreaterThan(0);

    for (const url of urls) {
      expect(url, `${url} にハッシュが入っていない`).toMatch(/\.[0-9a-f]{16}\./);

      const response = await createApp().fetch(
        new Request(`${ORIGIN}${url}`),
        envWith({} as never),
        executionContext(),
      );
      expect(response.status, `${url} が引けない`).toBe(200);
      expect(response.headers.get("Cache-Control")).toContain("immutable");
    }
  });
});

describe("サーバーの HTML にボタンを置かない", () => {
  // **押しても効かないボタンを作らないため**（`client/account-island.ts`）。
  // サーバー側で描いて JS で有効化する形だと、読み込み失敗のときだけ
  // 死んだボタンが残る。`<noscript>` はそのとき出ない。
  it.each([OVERVIEW_PATH, SESSIONS_PATH, GRANTS_PATH])("%s", async (path) => {
    expect(await html(path)).not.toContain("<button");
  });
});

describe("JS が無いとできないことを伝える", () => {
  it.each([OVERVIEW_PATH, SESSIONS_PATH, GRANTS_PATH])("%s に noscript がある", async (path) => {
    const page = await html(path);
    expect(page).toContain("<noscript>");
    expect(page).toContain("JavaScript");
  });

  it.each([OVERVIEW_PATH, SESSIONS_PATH, GRANTS_PATH])(
    "%s は代わりにできることへ案内する",
    async (path) => {
      // **できないことだけを書くと行き止まりになる**（#208）。全端末の
      // ログアウトは auth-worker のログイン画面から JS 無しで届くので、
      // そこへ送る。身に覚えのない端末を見つけた人の手がここで止まるのが
      // 一番まずい。
      const page = await html(path);
      expect(page).toContain('href="/login"');
      expect(page).toContain("すべての端末からログアウト");
    },
  );
});

describe("空になったときの文言をサーバーと揃える", () => {
  // アイランドは最後の 1 件を消したあと `data-empty-text` を出す。
  // そこがサーバーの「ありません」と違うと、**操作の前後で文言が変わる。**
  // アイランドに日本語を持たせず属性で渡しているのはそのため。
  it.each([
    [OVERVIEW_PATH, { ...IDENTITY, listPasskeys: async () => rpcOk([] as PasskeySummary[]) }],
    [SESSIONS_PATH, { listSessions: async () => rpcOk([] as SessionListItem[]) }],
    [GRANTS_PATH, { listGrants: async () => rpcOk([] as GrantListItem[]) }],
  ])("%s", async (path, emptyIdentity) => {
    const withItems = await html(path);
    const emptyText = /data-empty-text="([^"]+)"/.exec(withItems)?.[1];
    expect(emptyText, `${path} に data-empty-text が無い`).toBeDefined();

    const whenEmpty = await html(path, emptyIdentity);
    expect(whenEmpty).toContain(`<p class="empty">${emptyText as string}</p>`);
  });
});
