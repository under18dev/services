import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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

describe("未認証アクセス", () => {
  it.each(["/api/me", "/api/me/sessions"])("%s は Cookie 無しで 401", async (path) => {
    const response = await SELF.fetch(`http://localhost${path}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthenticated" });
  });

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
