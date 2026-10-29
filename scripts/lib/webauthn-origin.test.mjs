import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWebAuthnVars } from "./webauthn-origin.mjs";

/** いま実在する 2 つの env。どちらも通らなければ検査の側が壊れている。 */
test("本番の値は通る", () => {
  assert.deepEqual(
    checkWebAuthnVars({ RP_ID: "under18.dev", WEBAUTHN_ORIGIN: "https://auth.under18.dev" }),
    [],
  );
});

test("既定 env の localhost も通る", () => {
  assert.deepEqual(
    checkWebAuthnVars({ RP_ID: "localhost", WEBAUTHN_ORIGIN: "http://localhost:8787" }),
    [],
  );
});

test("RP_ID と origin のホストが同じでも通る", () => {
  // RP_ID をゾーンにするかホストにするかは設計判断（wrangler.jsonc に理由がある）。
  // この検査は**噛み合っているか**だけを見て、どちらを選ぶかには口を出さない。
  assert.deepEqual(
    checkWebAuthnVars({ RP_ID: "auth.under18.dev", WEBAUTHN_ORIGIN: "https://auth.under18.dev" }),
    [],
  );
});

test("Passkey を持たない Worker（両方無い）は対象外", () => {
  assert.deepEqual(checkWebAuthnVars({}), []);
});

test("RP_ID が origin のホストの接尾辞でないと落ちる", () => {
  const problems = checkWebAuthnVars({
    RP_ID: "example.com",
    WEBAUTHN_ORIGIN: "https://auth.under18.dev",
  });
  assert.match(problems.join("\n"), /接尾辞になっていない/);
});

test("接尾辞が途中で切れている形も落ちる", () => {
  // "der18.dev" は "auth.under18.dev" の末尾文字列ではあるが、
  // ドメインの境界で切れていない。endsWith だけで書くと通ってしまう。
  const problems = checkWebAuthnVars({
    RP_ID: "der18.dev",
    WEBAUTHN_ORIGIN: "https://auth.under18.dev",
  });
  assert.match(problems.join("\n"), /接尾辞になっていない/);
});

test("ラベルが 1 つの RP_ID を落とす（接尾辞ではあるが登録可能ではない）", () => {
  // `auth.under18.dev` は `.dev` で終わるので、接尾辞の判定だけでは通る。
  // ブラウザは registrable domain でない rpId を拒むので、**この検査が
  // 守ろうとしているものがそのまま起きる。**
  const problems = checkWebAuthnVars({ RP_ID: "dev", WEBAUTHN_ORIGIN: "https://auth.under18.dev" });
  assert.match(problems.join("\n"), /登録可能なドメインではない/);
});

test("localhost は 1 ラベルでも通る（host と一致するため）", () => {
  assert.deepEqual(
    checkWebAuthnVars({ RP_ID: "localhost", WEBAUTHN_ORIGIN: "http://localhost:8787" }),
    [],
  );
});

test("逆向き（origin のほうが広い）も落ちる", () => {
  const problems = checkWebAuthnVars({
    RP_ID: "auth.under18.dev",
    WEBAUTHN_ORIGIN: "https://under18.dev",
  });
  assert.match(problems.join("\n"), /接尾辞になっていない/);
});

test("末尾の / を落とす", () => {
  const problems = checkWebAuthnVars({
    RP_ID: "under18.dev",
    WEBAUTHN_ORIGIN: "https://auth.under18.dev/",
  });
  assert.match(problems.join("\n"), /末尾の \//);
});

test("path 付きを落とす", () => {
  const problems = checkWebAuthnVars({
    RP_ID: "under18.dev",
    WEBAUTHN_ORIGIN: "https://auth.under18.dev/login",
  });
  assert.match(problems.join("\n"), /余計な path/);
});

test("localhost 以外の http を落とす", () => {
  const problems = checkWebAuthnVars({
    RP_ID: "under18.dev",
    WEBAUTHN_ORIGIN: "http://auth.under18.dev",
  });
  assert.match(problems.join("\n"), /Secure Context/);
});

test("片方だけなら落ちる", () => {
  assert.match(checkWebAuthnVars({ RP_ID: "under18.dev" }).join("\n"), /WEBAUTHN_ORIGIN が無い/);
  assert.match(
    checkWebAuthnVars({ WEBAUTHN_ORIGIN: "https://auth.under18.dev" }).join("\n"),
    /RP_ID が無い/,
  );
});

test("RP_ID に scheme や port や path が混ざっていたら落ちる", () => {
  for (const bad of [
    "https://under18.dev",
    "under18.dev:443",
    "under18.dev/",
    ".under18.dev",
    "Under18.dev",
  ]) {
    const problems = checkWebAuthnVars({ RP_ID: bad, WEBAUTHN_ORIGIN: "https://auth.under18.dev" });
    assert.match(problems.join("\n"), /ホスト名ではない/, bad);
  }
});

test("URL として読めない origin は落ちる", () => {
  const problems = checkWebAuthnVars({
    RP_ID: "under18.dev",
    WEBAUTHN_ORIGIN: "auth.under18.dev",
  });
  assert.match(problems.join("\n"), /URL として読めない/);
});
