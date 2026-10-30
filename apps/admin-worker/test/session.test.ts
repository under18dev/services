import { describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "../src/oidc/session";

const secret = new TextEncoder().encode("test-secret-at-least-32-bytes-long!!");

describe("admin-worker 自身のセッション", () => {
  it("作って検証すると sub が戻る", async () => {
    const token = await createSessionToken(secret, "usr_abc123");
    expect(await verifySessionToken(secret, token)).toEqual({ sub: "usr_abc123" });
  });

  it("違う鍵で検証すると null（署名が合わない）", async () => {
    const token = await createSessionToken(secret, "usr_abc123");
    const otherSecret = new TextEncoder().encode("different-secret-at-least-32-bytes!");
    expect(await verifySessionToken(otherSecret, token)).toBeNull();
  });

  it("壊れたトークンは例外を投げず null", async () => {
    expect(await verifySessionToken(secret, "not-a-jwt")).toBeNull();
  });

  it("alg を変えたトークンは拒否する（アルゴリズム混同対策）", async () => {
    // HS256 で発行したつもりが別アルゴリズムのヘッダへ差し替えられても
    // 通らないことを見る。jose の `algorithms` 固定が効いているか。
    const token = await createSessionToken(secret, "usr_abc123");
    const [header, payload, signature] = token.split(".");
    const tamperedHeader = btoa(JSON.stringify({ alg: "none", typ: "JWT" }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    expect(await verifySessionToken(secret, `${tamperedHeader}.${payload}.`)).toBeNull();
    void header;
    void signature;
  });
});
