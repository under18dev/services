import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createContainer } from "../src/composition/container";

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

/**
 * Env を上書きしたコピーを作る。
 *
 * `wrangler types` は wrangler.jsonc の vars をリテラル型で出すため
 * （ENVIRONMENT は "development" 固定）、別の値を入れるには一度型を外す。
 */
function envWith(overrides: Record<string, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

describe("シークレット未設定時の挙動", () => {
  it("development では IP_HASH_PEPPER が無くても起動する", () => {
    expect(() =>
      createContainer(envWith({ ENVIRONMENT: "development", IP_HASH_PEPPER: undefined })),
    ).not.toThrow();
  });

  it("development 以外で IP_HASH_PEPPER が無ければ起動を止める", () => {
    // 静かに既定の pepper へ落ちると、IPv4 のハッシュが総当たり可能になり
    // 匿名化が機能しなくなる。気づけないまま本番が動く方が危険なので落とす。
    expect(() =>
      createContainer(envWith({ ENVIRONMENT: "production", IP_HASH_PEPPER: undefined })),
    ).toThrow(/IP_HASH_PEPPER/);
  });

  it("development 以外で EMAIL バインディングが無ければ起動を止める", () => {
    // バインディングが無いまま本番が動くと、ConsoleEmailSender に落ちて
    // OTP がログに出るか、送信が静かに失敗する。
    expect(() =>
      createContainer(
        envWith({ ENVIRONMENT: "production", IP_HASH_PEPPER: "set", EMAIL: undefined }),
      ),
    ).toThrow(/EMAIL binding/);
  });

  it("development では EMAIL バインディングが無くても起動する", () => {
    expect(() =>
      createContainer(envWith({ ENVIRONMENT: "development", EMAIL: undefined })),
    ).not.toThrow();
  });
});
