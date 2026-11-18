import { describe, expect, it } from "vitest";
import { PepperedIpHasher } from "../src/infrastructure/crypto/web-crypto";

/**
 * IP アドレスのハッシュ化（仕様書 9 Privacy）。
 *
 * 構成は `HMAC-SHA256(key = pepper, message = ip)` を 16 進小文字 64 文字で
 * 出す。以前の `SHA-256("${pepper}:${ip}")` から切り替えた（ランブック 2.4.2）。
 *
 * 期待値はこの実装とは独立に OpenSSL で計算したもの:
 *
 *     printf '%s' '<message>' | openssl dgst -sha256 -hmac '<key>'
 */

const HEX_64 = /^[0-9a-f]{64}$/;

describe("PepperedIpHasher", () => {
  it("RFC 4231 Test Case 2 の HMAC-SHA256 と一致する", async () => {
    const hasher = new PepperedIpHasher("Jefe");

    await expect(hasher.hash("what do ya want for nothing?")).resolves.toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("IPv4 を HMAC-SHA256(pepper, ip) にする", async () => {
    const hasher = new PepperedIpHasher("test-pepper");

    await expect(hasher.hash("198.51.100.7")).resolves.toBe(
      "e64e5b4ffefe8aa8d9f1e25e3b837cd238352bb0ecb3fb5bc4f5fa42f5459a77",
    );
  });

  it("IPv6 も同じ構成で扱う", async () => {
    const hasher = new PepperedIpHasher("test-pepper");

    await expect(hasher.hash("2001:db8::1")).resolves.toBe(
      "bfe05a21612812701ad85898781375f7cbcfba07d60901ae197b869f22a737fe",
    );
  });

  it("以前の SHA-256(pepper:ip) とは別の値になる", async () => {
    const hasher = new PepperedIpHasher("test-pepper");

    // printf '%s' 'test-pepper:198.51.100.7' | openssl dgst -sha256
    await expect(hasher.hash("198.51.100.7")).resolves.not.toBe(
      "a859e788d7c1a65a6f5a111608dcc71ba7e1fbfb1999367593489e3c24c38fe2",
    );
  });

  it("出力の形（16 進小文字 64 文字）は以前と変わらない", async () => {
    const hash = await new PepperedIpHasher("test-pepper").hash("198.51.100.1");

    expect(hash).toMatch(HEX_64);
  });

  it("同じ pepper と IP なら何度呼んでも同じ値になる", async () => {
    const a = new PepperedIpHasher("test-pepper");
    const b = new PepperedIpHasher("test-pepper");

    const first = await a.hash("198.51.100.1");
    expect(await a.hash("198.51.100.1")).toBe(first);
    // 別インスタンス（= 別リクエストのコンテナ）でも同じ
    expect(await b.hash("198.51.100.1")).toBe(first);
  });

  it("pepper が違えば同じ IP でも別の値になる", async () => {
    const ip = "198.51.100.1";
    const [x, y] = await Promise.all([
      new PepperedIpHasher("pepper-a").hash(ip),
      new PepperedIpHasher("pepper-b").hash(ip),
    ]);

    expect(x).not.toBe(y);
  });

  it("pepper を交互に切り替えても取り違えない", async () => {
    // 鍵をキャッシュしているので、別の pepper の鍵を使い回していないことを見る
    const ip = "198.51.100.1";
    const a1 = await new PepperedIpHasher("pepper-a").hash(ip);
    const b1 = await new PepperedIpHasher("pepper-b").hash(ip);
    const a2 = await new PepperedIpHasher("pepper-a").hash(ip);

    expect(a2).toBe(a1);
    expect(b1).not.toBe(a1);
  });

  it("空の pepper はハッシュ化の時点で失敗する", async () => {
    // 以前の構成では `":${ip}"` の SHA-256 —— 実質 pepper なし —— が黙って
    // 出ていた。HMAC は長さ 0 の鍵を import できないので、未設定と同じく
    // ハッシュ化しようとした時点で投げる（UnconfiguredIpHasher と同じ面で落ちる）。
    await expect(new PepperedIpHasher("").hash("198.51.100.1")).rejects.toThrow();
  });

  it("IP が違えば別の値になる", async () => {
    const hasher = new PepperedIpHasher("test-pepper");

    expect(await hasher.hash("198.51.100.1")).not.toBe(await hasher.hash("198.51.100.2"));
  });
});
