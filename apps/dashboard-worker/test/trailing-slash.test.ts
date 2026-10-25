import { DEV_SESSION_COOKIE_NAME, rpcOk } from "@u18/contracts";
import type { UserProfile } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE_PATH, createApp } from "../src/presentation/http/app";
import { ORIGIN, envWith, executionContext } from "./helpers";

/**
 * 末尾スラッシュの有無を同一視する（`strict: false`）。
 *
 * **これが無いと `/account` と `/account/` の片方が 404 になる。**
 * どちらが生きるかは登録の書き方で決まる —— `basePath("/account")` の下に
 * `get("/")` と書けば `/account/` だけ、`route("/", ...)` で合流させれば
 * `/account` だけが届く。**利用者が URL バーに打つのは前者**なので、
 * 書き方に依らず両方踏めることをここで固定する。
 *
 * 実際に両方の書き方が別々の実装で採られ、それぞれ逆側を 404 にしていた。
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

async function get(path: string): Promise<Response> {
  return await createApp().fetch(
    new Request(`${ORIGIN}${path}`, {
      headers: { Cookie: `${DEV_SESSION_COOKIE_NAME}=token-value` },
    }),
    envWith({ getUserProfile: async () => rpcOk(PROFILE) }),
    executionContext(),
  );
}

describe("末尾スラッシュ", () => {
  it.each([
    [`${ACCOUNT_BASE_PATH}/api/me`, "付けない"],
    [`${ACCOUNT_BASE_PATH}/api/me/`, "付ける"],
  ])("%s（%s）は同じに届く", async (path) => {
    const response = await get(path);
    // 404 でなければよい。認証の結果そのものは api.test.ts が持っている。
    expect(response.status).not.toBe(404);
  });
});
