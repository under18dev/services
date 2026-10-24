import { describe, expect, it } from "vitest";
import {
  matchesRegisteredRedirectUri,
  validateRedirectUriForRegistration,
} from "../src/domain/services/redirect-uri";

describe("Redirect URI の登録時検証", () => {
  it("https の絶対 URI を受け入れる", () => {
    const result = validateRedirectUriForRegistration("https://app.example/oauth/callback");
    expect(result).toEqual({ ok: true, uri: "https://app.example/oauth/callback" });
  });

  it("クエリ付きでも登録できる", () => {
    const uri = "https://app.example/cb?tenant=u18";
    expect(validateRedirectUriForRegistration(uri)).toEqual({ ok: true, uri });
  });

  it.each([
    ["相対 URI", "/oauth/callback", "not_absolute"],
    ["スキームなし", "app.example/cb", "not_absolute"],
    ["http（ループバックでない）", "http://app.example/cb", "insecure_scheme"],
    ["別スキーム", "u18app://callback", "insecure_scheme"],
    ["フラグメント付き", "https://app.example/cb#token", "has_fragment"],
    ["空のフラグメント", "https://app.example/cb#", "has_fragment"],
    ["認証情報付き", "https://user:pw@app.example/cb", "has_credentials"],
    ["大文字スキーム", "HTTPS://app.example/cb", "not_normalized"],
    ["既定ポートの明示", "https://app.example:443/cb", "not_normalized"],
    ["パス省略", "https://app.example", "not_normalized"],
  ])("%s は拒否する", (_label, uri, reason) => {
    expect(validateRedirectUriForRegistration(uri)).toEqual({ ok: false, reason });
  });

  describe("ローカル開発の http", () => {
    // https を要求する理由は認可コードが平文で経路に載ることだが、
    // ループバック宛はマシンの外へ出ないのでその前提が成り立たない。
    // ただし「既定で許さない」ことが本体の判断（redirect-uri.ts のコメント参照）。
    it.each(["http://localhost:8788/cb", "http://127.0.0.1:8788/cb", "http://[::1]:8788/cb"])(
      "%s は明示的に許可したときだけ通る",
      (uri) => {
        expect(validateRedirectUriForRegistration(uri)).toEqual({
          ok: false,
          reason: "insecure_scheme",
        });
        expect(validateRedirectUriForRegistration(uri, { allowLoopbackHttp: true })).toEqual({
          ok: true,
          uri,
        });
      },
    );

    it("ループバックでないホストは allowLoopbackHttp を立てても http を許さない", () => {
      expect(
        validateRedirectUriForRegistration("http://localhost.evil.test/cb", {
          allowLoopbackHttp: true,
        }),
      ).toEqual({ ok: false, reason: "insecure_scheme" });
    });
  });
});

describe("Redirect URI の照合", () => {
  const registered = ["https://app.example/cb", "https://app.example/cb?tenant=u18"];

  it("登録済みの文字列と完全一致すればマッチする", () => {
    expect(matchesRegisteredRedirectUri("https://app.example/cb", registered)).toBe(true);
    expect(matchesRegisteredRedirectUri("https://app.example/cb?tenant=u18", registered)).toBe(
      true,
    );
  });

  it.each([
    ["クエリが 1 文字違う", "https://app.example/cb?tenant=u19"],
    ["クエリが増えている", "https://app.example/cb?tenant=u18&x=1"],
    ["末尾スラッシュが増えている", "https://app.example/cb/"],
    ["サブパスが生えている", "https://app.example/cb/evil"],
    ["前方一致を狙ったホスト", "https://app.example.evil.test/cb"],
    ["大文字小文字が違う", "https://APP.example/cb"],
    ["パストラバーサル", "https://app.example/cb/../open-redirect?to=evil"],
    ["空文字", ""],
  ])("%s なら一致しない", (_label, requested) => {
    expect(matchesRegisteredRedirectUri(requested, registered)).toBe(false);
  });

  it("登録が無いクライアントはどんな URI もマッチしない", () => {
    expect(matchesRegisteredRedirectUri("https://app.example/cb", [])).toBe(false);
  });
});
