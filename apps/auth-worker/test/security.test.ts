import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SESSION_ROUTES } from "./route-inventory";

/** Origin 検証が通る値（`ISSUER` と同じ）。 */
const ORIGIN = "http://localhost:8787";

/**
 * 「失敗すること」を確かめるテスト。
 *
 * これらは実装を変えたときに静かに通ってしまいやすいので、
 * 期待する拒否のされ方まで検証する。
 */

describe("状態変更 API の Origin 検証", () => {
  const sessionCookie = "u18_session=some-token-value";

  it("Origin が無い DELETE を拒否する", async () => {
    const response = await SELF.fetch("http://localhost/api/me/sessions/ses_x", {
      method: "DELETE",
      headers: { Cookie: sessionCookie },
    });

    // Origin 欠如を「通す」と、CSRF 対策が SameSite だけに頼ることになる。
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden" });
  });

  it("別オリジンからの DELETE を拒否する", async () => {
    const response = await SELF.fetch("http://localhost/api/me/sessions/ses_x", {
      method: "DELETE",
      headers: { Cookie: sessionCookie, Origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
  });

  it("Cookie が無ければ Origin 検証の前に 401 を返す", async () => {
    const response = await SELF.fetch("http://localhost/api/me/sessions/ses_x", {
      method: "DELETE",
    });

    expect(response.status).toBe(401);
  });
});

/**
 * `SESSION_ROUTES` に載せたものが、本当にセッションを要求すること（#275 / #278）。
 *
 * ## 一覧を「表」から「検査」にする
 *
 * `route-inventory.test.ts` は**一覧と実際のルートが一致すること**を見ている。
 * だが区分（public / session / oauth）は手で書くもので、**`SESSION_ROUTES` に
 * 載せたものが実際に認証を要求するかは誰も見ていなかった。** 区分を取り違えて
 * 載せても緑のままで、「ここは Cookie が要る」という一覧の主張が裏取り無しに
 * 残る。
 *
 * **ここを一覧から回すと、取り違えがその場で落ちる。**
 *
 * ## `PUBLIC_ROUTES` 側は回さない
 *
 * 「401 にならないこと」は弱い主張である（400 でも 302 でも通る）うえ、
 * 公開経路には副作用がある（メール送信・行の生成）。区分の取り違えは
 * `SESSION_ROUTES` 側を固定するだけで捕まる。
 */
describe("未認証アクセス", () => {
  // **0 件ガード。** `it.each([])` はテストを 1 つも作らずに緑になるので、
  // 一覧が空になったときこの describe 全体が黙る。
  it("SESSION_ROUTES が空でない", () => {
    expect(SESSION_ROUTES.length).toBeGreaterThan(0);
  });

  // **`Origin` は通る値を付ける。** ここで見たいのは「セッションが要るか」
  // だけで、Origin 検証に引っ掛けてしまうと**どちらで止まったのか分からない。**
  //
  // 実際、止まる場所は経路ごとに違う —— `me.routes.ts` は Cookie を先に見て
  // 401 を返すが（上の「Cookie が無ければ Origin 検証の前に 401」）、
  // `auth.passkey.routes.ts` の register は Origin が先で、ヘッダを付けないと
  // **403 になる。** どちらでも守れてはいるが、**403 を「セッションを要求して
  // いる証拠」と読むことはできない**（Origin を落としただけでも 403 になる）。
  //
  // `:id` は実在しない値で埋める。**認証が先に来るなら、存在しない ID でも
  // 401 が返る。** 404 が返ったら資源を引いてから認証していることになり、
  // それは ID の実在が未認証で読めるということなので、**落ちたら実装のほうを
  // 疑うこと。**
  it.each(SESSION_ROUTES.map((route) => [`${route.method} ${route.path}`, route] as const))(
    "%s は Cookie 無しで 401",
    async (_label, route) => {
      const path = route.path.replaceAll(/:[A-Za-z]+/g, "does-not-exist");
      const response = await SELF.fetch(`http://localhost${path}`, {
        method: route.method,
        headers: { Origin: ORIGIN },
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "unauthenticated" });
    },
  );

  it("無効なセッショントークンでも 401 になる", async () => {
    const response = await SELF.fetch("http://localhost/api/me", {
      headers: { Cookie: "u18_session=not-a-real-session" },
    });
    expect(response.status).toBe(401);
  });
});

// 設定不備（EMAIL バインディング / IP_HASH_PEPPER 未設定）の扱いは
// config-resilience.test.ts を参照。起動時ではなく利用時に失敗させる方針なので、
// 「createContainer が throw すること」ではなく
// 「sendOtp / hash が reject し、/health は 200 のままであること」を検証している。
