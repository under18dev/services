import assert from "node:assert/strict";
import { test } from "node:test";
import { assertHttpsEndpoint } from "./s3-endpoint.mjs";

test("https はそのまま通る", () => {
  const url = assertHttpsEndpoint("https://abc123.r2.cloudflarestorage.com");
  assert.equal(url.protocol, "https:");
  assert.equal(url.host, "abc123.r2.cloudflarestorage.com");
});

test("http は拒む（平文のメールアドレスが暗号化されずに流れる）", () => {
  assert.throws(() => assertHttpsEndpoint("http://abc123.r2.cloudflarestorage.com"), /https/);
});

test("localhost でも http なら拒む", () => {
  // 手元での動作確認のつもりで書いた http:// が、そのまま本番の退避先に
  // なりうる。`.env` は gitignore 済みでレビューを通らないので、
  // 「開発中だけ」という例外を設けない。
  assert.throws(() => assertHttpsEndpoint("http://localhost:9000"), /https/);
});

test("URL として読めないものは拒む", () => {
  for (const bad of ["", "abc123.r2.cloudflarestorage.com", "not a url"]) {
    assert.throws(() => assertHttpsEndpoint(bad), /URL として読めない/);
  }
});

test("https 以外のスキームも拒む", () => {
  for (const bad of ["ftp://example.com", "file:///etc/passwd", "s3://bucket"]) {
    assert.throws(() => assertHttpsEndpoint(bad), /https/);
  }
});
