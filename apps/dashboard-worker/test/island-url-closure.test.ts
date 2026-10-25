import { DEV_SESSION_COOKIE_NAME, rpcOk } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { createApiClient } from "../src/presentation/http/ui/client/api-client";
import { ORIGIN, envWith, executionContext } from "./helpers";

/**
 * **アイランドが実際に組み立てる URL が、ハンドラに届くこと。**
 *
 * ## すでにある検査では足りない
 *
 * - `client-type.test-d.ts` は**型**しか見ない。`hc` のパスが実在すること
 *   は型で保証されるが、`hc` が**その型からどんな URL を作るか**は別の話で
 *   ある（接頭辞の付き方、パラメータの差し込み方）。
 * - `route-inventory.test.ts` は**登録されたパターン**（`/account/api/me/
 *   sessions/:id`）を見る。実際の URL（`/account/api/me/sessions/ses_1`）が
 *   そのパターンに一致するかは見ていない。
 * - `ui-island.test.ts` は**アイランドが配信されること**までで、中身が
 *   どこを叩くかは見ていない。
 *
 * つまり `hc` の URL 生成を挟んだ**往復**は、どの検査も通っていなかった。
 * `hc` の基点（`hc<T>(location.origin)`）の渡し方を間違えて
 * `/account/account/api/...` を作るような壊れ方は、**型も一覧も通る。**
 *
 * ## やっていること
 *
 * `hc` の `$url()` で**アイランドと同じ経路で URL を作り**、その URL を
 * `createApp().fetch()` に食わせて 404 にならないことを見る。
 * 生成側と受け側の両方を本物にしてあるので、間に挟まるものが変わっても
 * 追随する。
 *
 * 脅威モデル §4.4 の言い方では、**型という面に対する「実行時の URL」という
 * 独立した面**にあたる。
 */

// **アイランドと同じ関数**を呼ぶ（`client/api-client.ts`）。ここで
// `hc<DashboardAppType>(ORIGIN)` と書き直すと、検査しているのは
// 「テストの中の組み立て方」になり、アイランドが間違っていても通る。
const client = createApiClient(ORIGIN);

/** 取り消し操作の 3 本。アイランドの `ACTIONS` と対になっている。 */
const CALLS = [
  ["sessions", client.account.api.me.sessions[":id"].$url({ param: { id: "ses_1" } })],
  ["passkeys", client.account.api.me.passkeys[":id"].$url({ param: { id: "pk_1" } })],
  ["grants", client.account.api.me.grants[":clientId"].$url({ param: { clientId: "cli_1" } })],
] as const;

const IDENTITY = {
  revokeSession: async () => rpcOk({ revoked: true, self: false }),
  deletePasskey: async () => rpcOk({ deleted: true, remaining: 1 }),
  revokeGrant: async () => rpcOk({ revoked: true, revokedTokenCount: 0 }),
};

describe("アイランドが作る URL がハンドラに届く", () => {
  it.each(CALLS)("%s", async (_name, url) => {
    const response = await createApp().fetch(
      new Request(url, {
        method: "DELETE",
        headers: { Cookie: `${DEV_SESSION_COOKIE_NAME}=token-value`, Origin: ORIGIN },
      }),
      envWith(IDENTITY as never),
      executionContext(),
    );

    // **404 でないことが本題。** 認可や本文の中身は api.test.ts が持っている。
    // ここで見たいのは「その URL にハンドラがあるか」だけ。
    expect(response.status, `${url.href} が 404`).not.toBe(404);
    expect(response.status).toBe(200);
  });

  it("接頭辞が二重にならない", () => {
    // `hc<T>(base)` の base に接頭辞まで渡すと `/account/account/...` になる。
    // 型は通り、一覧も通り、**ブラウザで 404 になって初めて分かる。**
    for (const [, url] of CALLS) {
      expect(url.pathname.startsWith("/account/api/"), url.pathname).toBe(true);
      expect(url.pathname).not.toContain("/account/account/");
    }
  });

  it("パラメータが差し込まれている", () => {
    // `:id` のまま送ると、ルートには一致するので 404 にならない。
    // **上のテストだけでは通ってしまう**ので、ここで別に見る。
    const [, sessions] = CALLS[0];
    expect(sessions.pathname).toBe("/account/api/me/sessions/ses_1");
    expect(sessions.pathname).not.toContain(":");
  });
});
