import { DEV_SESSION_COOKIE_NAME, rpcErr, rpcOk } from "@u18/contracts";
import type { PasskeySummary, UserProfile } from "@u18/contracts";
import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE_PATH, createApp } from "../src/presentation/http/app";
import { ORIGIN, envWith, executionContext } from "./helpers";

/**
 * プロフィール更新と Passkey 管理の BFF（仕様書 8.1 / #11 / #75）。
 *
 * **この Worker は判断しない。** 再認証が要るかも、username が使えるかも、
 * 管理者が最後の Passkey を消せるかも、すべて auth-worker 側で決まる。
 * ここで確かめるのは **RPC の失敗を HTTP へ正しく翻訳しているか**だけ。
 *
 * 判断をこちらへ写すと 2 箇所になり、**片方だけ緩める変更が通る。**
 */

const COOKIE = `${DEV_SESSION_COOKIE_NAME}=token-value`;

const PROFILE: UserProfile = {
  id: "usr_test",
  username: "taro",
  displayName: "Taro",
  email: "taro@example.com",
  emailVerified: true,
  status: "active",
  createdAt: "2026-10-25T00:00:00.000Z",
};

async function request(path: string, env: Env, init: RequestInit = {}): Promise<Response> {
  return await createApp().fetch(
    new Request(`${ORIGIN}${ACCOUNT_BASE_PATH}${path}`, init),
    env,
    executionContext(),
  );
}

const patch = (env: Env, body: unknown, headers: Record<string, string> = {}) =>
  request("/api/me", env, {
    method: "PATCH",
    headers: { Cookie: COOKIE, Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("PATCH /api/me", () => {
  it("displayName を更新できる", async () => {
    const env = envWith({
      updateProfile: async () =>
        rpcOk({
          profile: { ...PROFILE, displayName: "新しい名前" },
          changedFields: ["displayName"],
        }),
    });

    const response = await patch(env, { displayName: "新しい名前" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changedFields: ["displayName"] });
  });

  it("再認証が要るときは 403 と理由を返す", async () => {
    // **`forbidden` と畳まない。** 利用者の次の行動が違う ——
    // こちらは「もう一度ログインすれば通る」であって権限の話ではない。
    const env = envWith({
      updateProfile: async () =>
        rpcErr("reauthentication_required", "recent authentication is required"),
    });

    const response = await patch(env, { username: "newname" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "reauthentication_required" });
  });

  it("username が使われていれば 409", async () => {
    // 400 にしない —— 入力の形は正しく、いまの状態では通らないという意味。
    const env = envWith({
      updateProfile: async () => rpcErr("conflict", "username is not available"),
    });

    const response = await patch(env, { username: "taken" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict" });
  });

  it("Origin が無ければ RPC を呼ばない", async () => {
    let called = false;
    const env = envWith({
      updateProfile: async () => {
        called = true;
        return rpcOk({ profile: PROFILE, changedFields: [] });
      },
    });

    const response = await request("/api/me", env, {
      method: "PATCH",
      headers: { Cookie: COOKIE, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "x" }),
    });

    expect(response.status).toBe(403);
    expect(called, "Origin 検証の前に RPC を呼んでいる").toBe(false);
  });

  it("更新できる項目が 1 つも無ければ 400", async () => {
    // email や status を送っても届かないこと。契約の入力型に無い。
    let called = false;
    const env = envWith({
      updateProfile: async () => {
        called = true;
        return rpcOk({ profile: PROFILE, changedFields: [] });
      },
    });

    const response = await patch(env, { email: "evil@example.com", status: "active" });

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  it("Cookie が無ければ 401", async () => {
    const response = await request("/api/me", envWith({}), {
      method: "PATCH",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "x" }),
    });

    expect(response.status).toBe(401);
  });
});

describe("GET /api/me/passkeys", () => {
  const SUMMARY: PasskeySummary = {
    id: "pk_1",
    label: "iPhone",
    deviceType: "multiDevice",
    createdAt: "2026-10-25T00:00:00.000Z",
    lastUsedAt: null,
  };

  it("一覧を返す", async () => {
    const env = envWith({ listPasskeys: async () => rpcOk([SUMMARY]) });

    const response = await request("/api/me/passkeys", env, { headers: { Cookie: COOKIE } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ passkeys: [SUMMARY] });
  });

  it("受けた DTO をそのまま返す（加工しない）", async () => {
    // **契約に項目を足すと、そのまま利用者のブラウザへ届く。**
    // ここでフィルタしていないことを明示しておく（`/api/me/grants` と同じ）。
    const env = envWith({ listPasskeys: async () => rpcOk([SUMMARY]) });

    const body = (await (
      await request("/api/me/passkeys", env, {
        headers: { Cookie: COOKIE },
      })
    ).json()) as { passkeys: unknown[] };

    expect(Object.keys(body.passkeys[0] as object).sort()).toEqual(
      ["createdAt", "deviceType", "id", "label", "lastUsedAt"].sort(),
    );
  });

  it("Cookie が無ければ 401", async () => {
    const response = await request("/api/me/passkeys", envWith({}));
    expect(response.status).toBe(401);
  });
});

describe("DELETE /api/me/passkeys/:id", () => {
  const del = (env: Env, headers: Record<string, string> = { Cookie: COOKIE, Origin: ORIGIN }) =>
    request("/api/me/passkeys/pk_1", env, { method: "DELETE", headers });

  it("削除できる", async () => {
    const env = envWith({ deletePasskey: async () => rpcOk({ deleted: true, remaining: 1 }) });

    const response = await del(env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, remaining: 1 });
  });

  it("再認証が要るときは 403", async () => {
    // セッション盗用がそのまま認証器の剥奪にならないこと（#75）。
    const env = envWith({
      deletePasskey: async () =>
        rpcErr("reauthentication_required", "recent authentication is required"),
    });

    expect((await del(env)).status).toBe(403);
  });

  it("管理者の最後の 1 本は 409", async () => {
    // 決定 8。判定は auth-worker 側にあり、ここは翻訳するだけ。
    const env = envWith({
      deletePasskey: async () =>
        rpcErr("conflict", "administrators must keep at least one passkey"),
    });

    const response = await del(env);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict" });
  });

  it("Origin が無ければ RPC を呼ばない", async () => {
    let called = false;
    const env = envWith({
      deletePasskey: async () => {
        called = true;
        return rpcOk({ deleted: true, remaining: 0 });
      },
    });

    const response = await del(env, { Cookie: COOKIE });

    expect(response.status).toBe(403);
    expect(called).toBe(false);
  });
});
