import { DEV_SESSION_COOKIE_NAME, rpcOk } from "@u18/contracts";
import type { GrantListItem, PasskeySummary, SessionListItem, UserProfile } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { ACCOUNT_ISLAND_JS } from "../src/presentation/http/ui/generated/account-island.bundle";
import {
  EMPTY_ATTR,
  ITEM_BODY_ATTR,
  ITEM_TITLE_ATTR,
  SERVER_RENDERED_HOOKS,
} from "../src/presentation/http/ui/island-hooks";
import { GRANTS_PATH, PASSKEYS_PATH, SESSIONS_PATH } from "../src/presentation/http/ui/asset-paths";
import { ORIGIN, envWith, executionContext } from "./helpers";

/**
 * サーバーの HTML と、アイランドが触る場所が噛み合っているか（#332）。
 *
 * ## ここが見えていなかった
 *
 * アイランドは `item.querySelector(".item-main")` のように**見た目の
 * クラスで引いて**いて、4 箇所とも `?.` で繋いである。**一致しなく
 * なっても例外が出ない** —— エラーの文言が出ない、読み上げが
 * 「この項目」になる、0 件からパスキーを登録しても一覧が出ない。
 *
 * **どれも応答を見ているテストでは分からない。** HTML も状態コードも
 * 正しいままである。#320 と同じ家系で、`styles.ts` が Tailwind に
 * 替わった瞬間（#332）に 3 つとも起きるところだった。
 *
 * ## 定数を共有するだけでは足りない
 *
 * 属性名は `island-hooks.ts` の 1 つにしてあるので、**名前が食い違う**
 * ことは起きない。起きるのは**サーバーが付け忘れる**ほうで、それは
 * 定数では防げない。だから**実際に描いて**確かめる。
 *
 * ## 両端を見る
 *
 * 画面に出ているだけでは「アイランドがまだ読んでいる」とは言えない。
 * バンドルにも同じ文字列が在ることを見て、**継ぎ目の両側**を押さえる。
 */

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
  current: true,
  createdAt: "2026-10-24T00:00:00.000Z",
  lastSeenAt: "2026-10-24T00:00:00.000Z",
  expiresAt: "2026-11-24T00:00:00.000Z",
  userAgent: "Mozilla/5.0",
};

const PASSKEY: PasskeySummary = {
  id: "pk_1",
  label: "MacBook",
  deviceType: null,
  createdAt: "2026-10-24T00:00:00.000Z",
  lastUsedAt: null,
};

const GRANT: GrantListItem = {
  clientId: "rp-1",
  clientName: "Example RP",
  logoUrl: null,
  scopes: ["openid"],
  grantedAt: "2026-10-24T00:00:00.000Z",
};

function identityWith(options: { readonly empty: boolean }): object {
  const some = <T>(value: T): readonly T[] => (options.empty ? [] : [value]);
  return {
    getUserProfile: async () => rpcOk(PROFILE),
    listSessions: async () => rpcOk(some(SESSION)),
    listPasskeys: async () => rpcOk(some(PASSKEY)),
    listGrants: async () => rpcOk(some(GRANT)),
  };
}

async function render(path: string, options: { readonly empty: boolean }): Promise<string> {
  const response = await createApp().fetch(
    new Request(`${ORIGIN}${path}`, {
      headers: { Cookie: `${DEV_SESSION_COOKIE_NAME}=token-value` },
    }),
    envWith(identityWith(options) as never),
    executionContext(),
  );
  expect(response.status, `${path} が ${response.status}`).toBe(200);
  return await response.text();
}

/** `<li ...>` を 1 件ずつ取り出す。入れ子の `<li>` はこの画面に無い。 */
function listItems(html: string): readonly string[] {
  return [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[0]);
}

/** 取り消しボタンが付く行。アイランドの `li[data-...-id]` と同じ条件。 */
const ACTION_PAGES = [
  [SESSIONS_PATH, "data-session-id"],
  [PASSKEYS_PATH, "data-passkey-id"],
  [GRANTS_PATH, "data-grant-client-id"],
] as const;

describe("アイランドが触る場所が HTML に在る", () => {
  it.each(ACTION_PAGES)("%s の行に本体と見出しがある", async (path, idAttribute) => {
    const html = await render(path, { empty: false });
    const rows = listItems(html).filter((row) => row.includes(idAttribute));

    // **0 件だと何も確かめずに通る。** 行が出ていないなら、この検査の
    // 前提（取り消しボタンが付く行がある）が崩れている。
    expect(rows.length, `${path} に ${idAttribute} を持つ行が無い`).toBeGreaterThan(0);

    for (const row of rows) {
      // 無いと、失敗したときの文言を**足す先が無い**（黙って出ない）。
      expect(row, `${path} の行に ${ITEM_BODY_ATTR} が無い`).toContain(ITEM_BODY_ATTR);
      // 無いと、読み上げと確認ダイアログが「この項目」になる。
      expect(row, `${path} の行に ${ITEM_TITLE_ATTR} が無い`).toContain(ITEM_TITLE_ATTR);
    }
  });

  it.each(ACTION_PAGES)("%s は 0 件のとき空の目印を出す", async (path) => {
    const html = await render(path, { empty: true });

    // パスキーの登録はこれを一覧へ差し替える。見つからないと
    // **登録は成功しているのに画面に出ない。**
    expect(html, `${path} の 0 件表示に ${EMPTY_ATTR} が無い`).toContain(EMPTY_ATTR);
  });

  it("アイランドが継ぎ目をまだ読んでいる", () => {
    // 画面に出ているだけでは、アイランドがそれを読んでいるとは言えない。
    // **片側を消しても、もう片側は緑のまま通る。**
    for (const hook of SERVER_RENDERED_HOOKS) {
      expect(ACCOUNT_ISLAND_JS, `バンドルが ${hook} を読んでいない`).toContain(hook);
    }
  });

  it("見た目のクラスでサーバーの HTML を引いていない", () => {
    // **移行のたびに変わる前提のものを継ぎ目に使わない**（#332）。
    // `className = "..."` の代入は残っている（アイランドが**作る**側で、
    // `island-classes.ts` の Tailwind のクラスを当てている）ので、
    // **引く側**の `querySelector` だけを見る。
    const selectors = [...ACCOUNT_ISLAND_JS.matchAll(/querySelector(?:All)?\(([^)]*)\)/g)].map(
      (m) => m[1] as string,
    );

    expect(selectors.length, "セレクタを 1 つも拾えていない").toBeGreaterThan(0);
    for (const selector of selectors) {
      // **`${...}` の中は見ない。** `li[${action.idAttribute}]` の `.` は
      // JS のプロパティ参照で、CSS のクラスではない。畳んでから見る。
      const literal = selector.replaceAll(/\$\{[^}]*\}/g, "");

      // クラスセレクタは `.` の直後が識別子の頭文字である。
      expect(literal, `クラスで引いている: ${selector}`).not.toMatch(/\.[A-Za-z_-]/);
    }
  });
});
