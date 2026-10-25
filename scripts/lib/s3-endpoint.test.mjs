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

// --- 宛先の検証（CodeQL の js/file-access-to-http に対する手当て） ---

test("R2 以外の宛先は拒む", () => {
  // https であることは「盗み見られない」だけで、正しい相手へ送っている
  // ことは保証しない。`.env` が書き換わると DB の複製が別の宛先へ届く。
  assert.throws(() => assertHttpsEndpoint("https://evil.example/"), /R2 ではない/);
});

test("URL 文字列の後方一致では抜けられる形を、ホストで止める", () => {
  // **`value.endsWith(".r2.cloudflarestorage.com")` だと両方とも通る。**
  // fragment もクエリも末尾に付けられるので、生の文字列に対する後方一致は
  // 宛先の判定にならない。パーサを通した hostname を見る。
  for (const bypass of [
    "https://evil.example/#.r2.cloudflarestorage.com",
    "https://evil.example/?x=.r2.cloudflarestorage.com",
  ]) {
    assert.throws(() => assertHttpsEndpoint(bypass), /R2 ではない/, bypass);
  }
});

test("点を挟まない前置きも拒む", () => {
  // `evil-r2.cloudflarestorage.com` は「r2.cloudflarestorage.com で終わる」が
  // R2 ではない。接尾辞の先頭に `.` を要求しているので落ちる。
  assert.throws(() => assertHttpsEndpoint("https://evil-r2.cloudflarestorage.com"), /R2 ではない/);
});

test("EU 管轄のエンドポイントは通る", () => {
  // `<accountid>.eu.r2.cloudflarestorage.com` という形もある。
  const url = assertHttpsEndpoint("https://abc123.eu.r2.cloudflarestorage.com");
  assert.equal(url.hostname, "abc123.eu.r2.cloudflarestorage.com");
});
