import { DEV_SESSION_COOKIE_NAME, RETURN_TO_PARAM, rpcErr, rpcOk } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE_PATH, createApp } from "../src/presentation/http/app";
import { ORIGIN, envWith, executionContext } from "./helpers";

/**
 * ログインが必要なときに、戻り先を載せてログイン画面へ案内する。
 *
 * **載せ忘れても誰も落ちない** —— 利用者が自分で辿り直すことになるだけで、
 * エラーにはならない。だから画面ごとに書かず 1 箇所に寄せてあり、
 * ここでは**全画面で載ること**を見る。
 */

const PAGES = ["", "/sessions", "/grants"] as const;

async function open(path: string, cookie: boolean): Promise<Response> {
  return await createApp().fetch(
    new Request(`${ORIGIN}${ACCOUNT_BASE_PATH}${path}`, {
      headers: cookie ? { Cookie: `${DEV_SESSION_COOKIE_NAME}=token-value` } : {},
    }),
    envWith({
      getUserProfile: async () => rpcErr("unauthenticated", "session is not valid"),
      listSessions: async () => rpcErr("unauthenticated", "session is not valid"),
      listGrants: async () => rpcErr("unauthenticated", "session is not valid"),
      listPasskeys: async () => rpcOk([]),
    }),
    executionContext(),
  );
}

describe("ログインが必要なときの戻り先", () => {
  it.each(PAGES)("%s は Cookie が無いときに戻り先を載せる", async (path) => {
    const html = await (await open(path, false)).text();
    const expected = `${ACCOUNT_BASE_PATH}${path}`;
    expect(html).toContain(`${RETURN_TO_PARAM}=${encodeURIComponent(expected)}`);
  });

  it.each(PAGES)("%s はセッションが無効なときにも戻り先を載せる", async (path) => {
    const html = await (await open(path, true)).text();
    const expected = `${ACCOUNT_BASE_PATH}${path}`;
    expect(html).toContain(`${RETURN_TO_PARAM}=${encodeURIComponent(expected)}`);
  });
});
