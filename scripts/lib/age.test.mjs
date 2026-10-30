import assert from "node:assert/strict";
import test from "node:test";
import { AGE_MAGIC, assertAgeBytes, assertRecipient, ageBinary } from "./age.mjs";

test("公開鍵は通る", () => {
  assert.equal(
    assertRecipient("age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"),
    "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
  );
});

test("前後の空白は落とす", () => {
  assert.equal(assertRecipient("  age1abc  "), "age1abc");
});

test("空は落ちる", () => {
  assert.throws(() => assertRecipient(""), /空/);
  assert.throws(() => assertRecipient("   "), /空/);
  assert.throws(() => assertRecipient(undefined), /空/);
});

test("★秘密鍵を受信者として渡したら止める", () => {
  // 設定を取り違えて秘密鍵を CI に置く事故を、使う前に止める。
  assert.throws(() => assertRecipient("AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ"), /秘密鍵/);
});

test("秘密鍵を弾くとき、値そのものはエラーに出さない", () => {
  // **エラー文は CI のログに出る。** そこへ鍵を載せない。
  const secret = "AGE-SECRET-KEY-1DONOTLEAKTHISVALUE";
  try {
    assertRecipient(secret);
    assert.fail("落ちるはず");
  } catch (error) {
    assert.doesNotMatch(error.message, /DONOTLEAKTHISVALUE/);
  }
});

test("age1 で始まらないものは落ちる", () => {
  assert.throws(() => assertRecipient("ssh-ed25519 AAAA"), /age1/);
});

test("age の出力は通る", () => {
  const bytes = Buffer.from(`${AGE_MAGIC}\n-> X25519 abc\n--- xyz\n\x00\x01`, "utf8");
  assert.doesNotThrow(() => assertAgeBytes(bytes, "テスト"));
});

test("★平文は落ちる（暗号化されずに上がる形）", () => {
  const plaintext = Buffer.from("CREATE TABLE users (id TEXT);\nINSERT INTO users ...", "utf8");
  assert.throws(() => assertAgeBytes(plaintext, "ダンプ"), /age の出力に見えない/);
});

test("平文を弾くとき、中身はエラーに出さない", () => {
  // 平文だった場合、ここに個人情報が載る。
  const plaintext = Buffer.from("INSERT INTO users VALUES ('taro@example.test');", "utf8");
  try {
    assertAgeBytes(plaintext, "ダンプ");
    assert.fail("落ちるはず");
  } catch (error) {
    assert.doesNotMatch(error.message, /example\.test/);
  }
});

test("★0 バイトは落ちる", () => {
  assert.throws(() => assertAgeBytes(Buffer.alloc(0), "ダンプ"), /空/);
});

test("ヘッダの途中までしか無いものも落ちる", () => {
  assert.throws(() => assertAgeBytes(Buffer.from("age-enc", "utf8"), "ダンプ"), /見えない/);
});

test("AGE_BIN で実行ファイルを差し替えられる", () => {
  assert.equal(ageBinary({}), "age");
  assert.equal(ageBinary({ AGE_BIN: "/opt/age/age" }), "/opt/age/age");
});
