import { passkeys } from "@u18/db";
import { newId } from "@u18/domain";
import { SELF, createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { IdentityAdminRPC } from "../src/presentation/rpc/identity-admin.entrypoint";
import { IdentityRPC } from "../src/presentation/rpc/identity.entrypoint";
import { appEnv, db, seedLoggedInUser, sessionCookie, type SeededUser } from "./helpers.oauth";
import { resetDatabase } from "./helpers";

/**
 * **HTTP 経路と RPC 経路で同じ判定が効くこと。**
 *
 * ## なぜこのファイルがあるか
 *
 * このリポジトリで繰り返している壊れ方は「実装は正しいが、その実装を
 * 呼ぶ経路が無い／迂回される」である（#88 / #96 / #122 / #132 / #141 /
 * #143 / #151 / #164）。
 *
 * **アカウント API はいま入口が 2 つある** —— 公開 HTTP（auth-worker 自身）と
 * Service Binding 越しの RPC（dashboard-worker から）。**最もありそうな
 * 次の形は「再認証の判定が HTTP のミドルウェアにあって RPC が素通りする」**
 * なので、同じ入力を両方の入口へ通して結果が一致することを固定する。
 *
 * ## 「両方で動く」ではなく「両方で同じに落ちる」を見る
 *
 * 成功経路だけ揃えても意味がない。**拒否されるべきものが片方だけ
 * 拒否される**のが危ない形なので、落ちるケースを中心に置く。
 */

const BASE = "http://localhost:8787";
const ORIGIN = BASE;

/** 再認証の窓（5 分）から確実に外れる古さ。 */
const STALE = new Date(Date.now() - 60 * 60 * 1000);

let rpc: IdentityRPC;
/**
 * 管理用は**別の Entrypoint**（#308）。Service Binding はメソッド単位で
 * 絞れないので、束縛を分けること自体が境界になっている ——
 * `IdentityRPC` を束縛している nfc-worker からは、こちらが見えない。
 */
let adminRpc: IdentityAdminRPC;

beforeEach(async () => {
  await resetDatabase();
  rpc = new IdentityRPC(createExecutionContext(), appEnv());
  adminRpc = new IdentityAdminRPC(createExecutionContext(), appEnv());
});

async function seedPasskey(user: SeededUser, id = newId("pk")): Promise<string> {
  await db()
    .insert(passkeys)
    .values({
      id,
      userId: user.userId,
      credentialId: `cred-${id}`,
      publicKey: "public-key-bytes",
      counter: 0,
      label: "テスト認証器",
      deviceType: "singleDevice",
      backedUp: false,
      transports: null,
    })
    .run();
  return id;
}

describe("username の変更には再認証が要る（両方の入口で）", () => {
  it("HTTP: 古いセッションでは 403 reauthentication_required", async () => {
    const user = await seedLoggedInUser({ authTime: STALE });

    const response = await SELF.fetch(`${BASE}/api/me`, {
      method: "PATCH",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: sessionCookie(user) },
      body: JSON.stringify({ username: "newname" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "reauthentication_required" });
  });

  it("RPC: 古いセッションでも同じく拒否される", async () => {
    // **ここが本体。** HTTP のミドルウェアに判定があると、この経路だけ
    // 通ってしまう —— dashboard から叩けば username を変えられる、という形。
    const user = await seedLoggedInUser({ authTime: STALE });

    const result = await rpc.updateProfile({
      sessionToken: user.sessionToken,
      username: "newname",
      caller: "dashboard-worker",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("reauthentication_required");
  });

  it("displayName だけなら、古いセッションでも両方で通る", async () => {
    // 再認証が要るのは username だけ。ここも揃っていないと、
    // 片方だけ余計に厳しい（利用者が理由の分からない失敗を踏む）。
    const forHttp = await seedLoggedInUser({ authTime: STALE });
    const forRpc = await seedLoggedInUser({ authTime: STALE });

    const response = await SELF.fetch(`${BASE}/api/me`, {
      method: "PATCH",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        Cookie: sessionCookie(forHttp),
      },
      body: JSON.stringify({ displayName: "新しい名前" }),
    });
    const viaRpc = await rpc.updateProfile({
      sessionToken: forRpc.sessionToken,
      displayName: "新しい名前",
      caller: "dashboard-worker",
    });

    expect(response.status).toBe(200);
    expect(viaRpc.ok).toBe(true);
  });

  it("新しいセッションなら username も両方で通る", async () => {
    const forHttp = await seedLoggedInUser();
    const forRpc = await seedLoggedInUser();

    const response = await SELF.fetch(`${BASE}/api/me`, {
      method: "PATCH",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        Cookie: sessionCookie(forHttp),
      },
      body: JSON.stringify({ username: "httpname" }),
    });
    const viaRpc = await rpc.updateProfile({
      sessionToken: forRpc.sessionToken,
      username: "rpcname",
      caller: "dashboard-worker",
    });

    expect(response.status).toBe(200);
    expect(viaRpc.ok).toBe(true);
  });
});

describe("Passkey 削除にも再認証が要る（両方の入口で）", () => {
  it("HTTP: 古いセッションでは 403", async () => {
    const user = await seedLoggedInUser({ authTime: STALE });
    const passkeyId = await seedPasskey(user);

    const response = await SELF.fetch(`${BASE}/api/me/passkeys/${passkeyId}`, {
      method: "DELETE",
      headers: { Origin: ORIGIN, Cookie: sessionCookie(user) },
    });

    expect(response.status).toBe(403);
  });

  it("RPC: 古いセッションでも同じく拒否される", async () => {
    // **セッションの盗用がそのまま認証器の剥奪にならないこと**が #75 の
    // 本体なので、入口が増えたらここも増やす。
    const user = await seedLoggedInUser({ authTime: STALE });
    const passkeyId = await seedPasskey(user);

    const result = await rpc.deletePasskey({
      sessionToken: user.sessionToken,
      passkeyId,
      caller: "dashboard-worker",
    });

    expect(!result.ok && result.error.code).toBe("reauthentication_required");
    // 行が残っていること。コードだけ見て「消えていない」を確かめない。
    expect(await db().select().from(passkeys).all()).toHaveLength(1);
  });

  it("新しいセッションなら RPC からも削除できる", async () => {
    const user = await seedLoggedInUser();
    const passkeyId = await seedPasskey(user);

    const result = await rpc.deletePasskey({
      sessionToken: user.sessionToken,
      passkeyId,
      caller: "dashboard-worker",
    });

    expect(result.ok && result.value).toEqual({ deleted: true, remaining: 0 });
    expect(await db().select().from(passkeys).all()).toHaveLength(0);
  });
});

describe("Passkey 一覧は credentialId と公開鍵を返さない", () => {
  it("RPC の戻り値に載らない", async () => {
    // 契約の `PasskeySummary` に無いので型でも落ちるが、**実際の値を
    // 走査して確かめる** —— 型はキャストで抜けられる（RR-13 と同じ方針）。
    const user = await seedLoggedInUser();
    await seedPasskey(user);

    const result = await rpc.listPasskeys({
      sessionToken: user.sessionToken,
      caller: "dashboard-worker",
    });

    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("public-key-bytes");
    expect(serialized).not.toContain("cred-");
  });

  it("HTTP の応答にも載らない（同じ保証）", async () => {
    const user = await seedLoggedInUser();
    await seedPasskey(user);

    const response = await SELF.fetch(`${BASE}/api/me/passkeys`, {
      headers: { Cookie: sessionCookie(user) },
    });

    const body = await response.text();
    expect(body).not.toContain("public-key-bytes");
    expect(body).not.toContain("cred-");
  });
});

describe("無効なセッションは両方の入口で拒否される", () => {
  it.each([
    ["updateProfile", () => rpc.updateProfile({ sessionToken: "x".repeat(40), displayName: "a" })],
    ["listPasskeys", () => rpc.listPasskeys({ sessionToken: "x".repeat(40) })],
    ["deletePasskey", () => rpc.deletePasskey({ sessionToken: "x".repeat(40), passkeyId: "pk_x" })],
    // #308 の管理用 3 メソッド。**HTTP の対になる経路はまだ無い**
    // （画面は dashboard-worker 側で、auth-worker にルートを足していない）。
    // 入口が RPC しかないからこそ、ここが唯一の固定になる。
    ["listOAuthClients", () => adminRpc.listOAuthClients({ sessionToken: "x".repeat(40) })],
    [
      "createOAuthClient",
      () =>
        adminRpc.createOAuthClient({
          sessionToken: "x".repeat(40),
          name: "x",
          clientType: "public",
          redirectUris: ["https://app.example/cb"],
        }),
    ],
    [
      "disableOAuthClient",
      () => adminRpc.disableOAuthClient({ sessionToken: "x".repeat(40), clientId: "u18-x" }),
    ],
  ])("%s は unauthenticated を返す", async (_name, invoke) => {
    const result = await invoke();
    expect(!result.ok && result.error.code).toBe("unauthenticated");
  });
});

/**
 * OAuth クライアント管理は**管理者のセッションでしか通らない**（#308）。
 *
 * ## なぜこのファイルにも置くか
 *
 * 判定は `application/use-cases/admin-access.ts` にあり、詳しい検査は
 * `oauth-client-admin.rpc.test.ts` が持っている。ここに置くのは
 * **「入口が増えたときに判定が素通りする」形を見張るのがこのファイルの
 * 役目**だからで、`updateProfile` の再認証と同じ位置づけになる。
 *
 * この 3 つは**登録経路を CLI から管理者へ広げる**変更にあたる
 * （脅威モデル RR-21）。判定が Presentation 層へ移っていないことを、
 * 契約の入口から 1 回通して確かめる。
 */
describe("OAuth クライアント管理は管理者のセッションでしか通らない", () => {
  it("一般利用者には not_found を返す（forbidden ではない）", async () => {
    const user = await seedLoggedInUser();

    const result = await adminRpc.listOAuthClients({
      sessionToken: user.sessionToken,
      caller: "dashboard-worker",
    });

    // 「権限がありません」と答えると、管理機能の存在が一般利用者に漏れる。
    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("登録には再認証が要る（管理者でも古いセッションでは通らない）", async () => {
    // **再認証の判定が片方の入口にしか無い**のがこのファイルの見張る形。
    // 登録はいま RPC からしか叩けないので、ここが唯一の固定になる。
    const admin = await seedLoggedInUser({ authTime: STALE, isAdmin: true, authMethod: "passkey" });

    const result = await adminRpc.createOAuthClient({
      sessionToken: admin.sessionToken,
      caller: "dashboard-worker",
      name: "古いセッションからの登録",
      clientType: "public",
      redirectUris: ["https://app.example/cb"],
    });

    expect(!result.ok && result.error.code).toBe("reauthentication_required");
  });

  it("管理者なら通る", async () => {
    const user = await seedLoggedInUser({ isAdmin: true, authMethod: "passkey" });

    const result = await adminRpc.listOAuthClients({
      sessionToken: user.sessionToken,
      caller: "dashboard-worker",
    });

    expect(result.ok).toBe(true);
  });

  it("旗が立っていても、OTP のセッションでは not_found になる", async () => {
    // **`users.is_admin` が true でも、このセッションでは管理者ではない**
    // （決定 8 / RR-5。`User.actsAsAdminWith`）。`requireAdminSession` は
    // `GetSessionUseCase` の返す `isAdmin` を見ているので、ここは
    // **判定を書き足さなくても効いている** —— 効いていることを固定する。
    //
    // **これが抜けると、管理領域だけが決定 8 の外に残る。** 上の「管理者なら
    // 通る」は `authMethod: "passkey"` で seed しているので、`actsAsAdminWith`
    // を `isAdmin` だけ見る形に戻しても緑のままになる。
    const user = await seedLoggedInUser({ isAdmin: true, authMethod: "email_otp" });

    const result = await adminRpc.listOAuthClients({
      sessionToken: user.sessionToken,
      caller: "dashboard-worker",
    });

    // 一般利用者とまったく同じ応答。「管理者だが方式が足りない」とは言わない。
    expect(!result.ok && result.error.code).toBe("not_found");
  });
});

/**
 * `getSession` が返す `isAdmin`（#187）。
 *
 * **nfc-worker はこの 1 ビットだけでカード発行の可否を決める。** 自分では
 * 判断できない（Identity D1 を持たない）ので、ここが実際の
 * `users.is_admin` を反映していなければ、**全員が発行できる**か
 * **誰も発行できない**かのどちらかになる。
 *
 * 常に `true` を返すよう壊しても nfc 側のテストは落ちない —— あちらは
 * fake の gateway を使うため。**その境目をこちらで塞ぐ。**
 *
 * **ここで `authMethod` を書くようになった経緯**（RR-5）。以前この
 * describe は `seedLoggedInUser()`（= `email_otp` のセッション）に
 * `is_admin` を立てて `true` を期待していた。つまり**「OTP セッションの
 * 管理者に権限が出る」ことをテストが固定していた**。決定 8 がそれを
 * 禁じているので、期待のほうを直した。条件は
 * `admin-session-passkey.test.ts` にまとめてある。
 */
describe("getSession の isAdmin は、このセッションで管理者として振る舞えるかを返す", () => {
  it("一般利用者は false", async () => {
    const user = await seedLoggedInUser();

    const result = await rpc.getSession({ sessionToken: user.sessionToken });

    expect(result.ok && result.value?.isAdmin).toBe(false);
  });

  it("管理者は true", async () => {
    const user = await seedLoggedInUser({ isAdmin: true, authMethod: "passkey" });

    const result = await rpc.getSession({ sessionToken: user.sessionToken });

    expect(result.ok && result.value?.isAdmin).toBe(true);
  });

  it("getUserProfile も同じ値を返す", async () => {
    // 2 箇所に同じ値があるので、片方だけ壊れる形を塞ぐ。
    const user = await seedLoggedInUser({ isAdmin: true, authMethod: "passkey" });

    const session = await rpc.getSession({ sessionToken: user.sessionToken });
    const profile = await rpc.getUserProfile({ sessionToken: user.sessionToken });

    expect(session.ok && session.value?.isAdmin).toBe(true);
    expect(profile.ok && profile.value?.isAdmin).toBe(true);
  });
});
