import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE_PATH, createApp } from "../src/presentation/http/app";
import { ORIGIN, envWith, executionContext, neverCalled } from "./helpers";

/**
 * `Cache-Control` が全経路に付いていること（#125 / 脅威モデル RR-10）。
 *
 * **この Worker が返すのは全部個人情報である。** auth-worker から中継した
 * プロフィール・セッション一覧・同意済みアプリで、中間プロキシやブラウザに
 * 残ると共用端末で前の利用者の情報が戻る。
 *
 * auth-worker と違い、**意図的に違う値を使う経路は 1 つも無い** ——
 * 静的アセットも公開メタデータもこの Worker には無い。
 */
describe("全経路に no-store が付く", () => {
  const identity = {
    getUserProfile: () => neverCalled("getUserProfile"),
    listSessions: () => neverCalled("listSessions"),
    listGrants: () => neverCalled("listGrants"),
    revokeSession: () => neverCalled("revokeSession"),
    revokeGrant: () => neverCalled("revokeGrant"),
  } as never;

  // Cookie を付けない。**401 でも付いている必要がある** —— 失敗応答が
  // キャッシュされると、後からログインしても 401 が返りうる。
  it.each([
    ["GET", `${ACCOUNT_BASE_PATH}/api/me`],
    ["GET", `${ACCOUNT_BASE_PATH}/api/me/sessions`],
    ["GET", `${ACCOUNT_BASE_PATH}/api/me/grants`],
    ["DELETE", `${ACCOUNT_BASE_PATH}/api/me/sessions/ses_x`],
    ["DELETE", `${ACCOUNT_BASE_PATH}/api/me/grants/cli_x`],
  ])("%s %s", async (method, path) => {
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${path}`, { method, headers: { Origin: ORIGIN } }),
      envWith(identity),
      executionContext(),
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("/account/health にも付く", async () => {
    // 死活確認がキャッシュされると、落ちていても緑に見える窓ができる。
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${ACCOUNT_BASE_PATH}/health`),
      envWith({ pingIdentity: async () => ({ ok: true, value: { status: "ok" } }) } as never),
      executionContext(),
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("接頭辞の無いパス（404）にも付く", async () => {
    const response = await createApp().fetch(
      new Request(`${ORIGIN}/api/me`),
      envWith(identity),
      executionContext(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
