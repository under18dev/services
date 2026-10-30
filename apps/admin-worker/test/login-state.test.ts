import { describe, expect, it } from "vitest";
import { decodeLoginState, encodeLoginState } from "../src/oidc/login-state";

describe("login-state cookie の符号化", () => {
  const value = { state: "s1", nonce: "n1", codeVerifier: "v1", returnTo: "/account" };

  it("往復する", () => {
    expect(decodeLoginState(encodeLoginState(value))).toEqual(value);
  });

  it("未指定・空は null", () => {
    expect(decodeLoginState(undefined)).toBeNull();
    expect(decodeLoginState("")).toBeNull();
  });

  it("壊れた base64 は例外を投げず null を返す", () => {
    expect(decodeLoginState("not valid base64url!!!")).toBeNull();
  });

  it("JSON として読めても形が違えば null", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ state: "only-this" }));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    expect(decodeLoginState(encoded)).toBeNull();
  });
});
