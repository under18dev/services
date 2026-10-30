import { describe, expect, it } from "vitest";
import { OtpPolicy, TokenLifetime } from "../src/domain/services/token-lifetime";

/**
 * **文書が言う数字を、実装の定数に固定する**（#364）。
 *
 * #358 で、カード ID が**文書は 100bit、本番は 80bit**とずれていた
 * ことが見つかった。原因は「長さが実装の 2 箇所に別々に書かれていた」
 * ことで、`newCardId()` 1 箇所へ寄せて閉じた。
 *
 * **`TokenLifetime` / `OtpPolicy` は最初から 1 箇所に寄っている**
 * （どちらも「期限の数字をコード中に散らさず、ここを単一の出典にする」
 * と冒頭に書いてある）。ただし、**それを使う既存のテストは全部
 * `TokenLifetime.sessionMs` のように定数を読んで比べるだけ**で、
 * **定数そのものの値を固定していない。** `sessionMs` を 12 時間から
 * 6 時間に変えても、既存のテストは 1 本も落ちない —— 落ちるのは
 * README / 脅威モデル / 仕様書の数字が、気づかれないまま嘘になる形。
 *
 * **ここは逆に、定数の値を文書の数字と突き合わせる。** 出典は各 `it` に
 * 書いた行番号（2026-10-31 時点）。**これは文書を固定する検査である。**
 * 定数を正しい理由で変えたら、このテストが落ちて初めて「どの文書を
 * 直すか」が分かる —— それが目的で、落ちること自体は想定済みである。
 *
 * ## 数えた範囲
 *
 * トークン・コードの長さ（セッション / CSRF / `client_secret` の
 * エントロピー、OTP の桁数）と鍵の種別（ES256）は、**ここでは見ない**:
 *
 * - **セッション / 認可コード / アクセストークン / `client_secret`
 *   のエントロピーは `WebCryptoTokenGenerator.generate()` の既定
 *   （32 バイト = 256bit）1 箇所に揃っており、`web-crypto.ts` の
 *   docblock が既にそれを言っている**（新しい定数が無い。コメントの
 *   数字と呼び出し側の引数を読んで確認した —— 固定する対象が無い）
 * - **ES256 は型で固定されている**（`alg: "ES256"` がリテラル型。
 *   変えると `tsc` が落ちる場所が複数ある）
 * - **レート制限（`RateLimitPolicy`）は既に `test/rate-limit-config.test.ts`
 *   が `wrangler.jsonc` と突き合わせている**（コード対設定）。
 *   コード対文書（runbook §13.2）は手で読み比べて一致を確認した
 * - **保持期間（`AuditRetention` / `NfcRetention`）は `retention.test.ts`
 *   がスキーマ側から数えて網羅を固定している。**日数そのもの
 *   （180 日 / 2 年）は手で読み比べて一致を確認した
 * - **カード ID の長さ・`isCardId()` は #365（94）の範囲。** ここでは
 *   触らない
 *
 * **ここで固定するのは、既存の検査が無く、かつ複数の文書が同じ数字を
 * 繰り返し引用している `TokenLifetime` / `OtpPolicy` だけ。** 他は
 * 既に別の形で守られているか、固定する対象（コード側の 1 箇所）が
 * 存在しない。
 */
describe("TokenLifetime —— 文書が引用する寿命", () => {
  it("認可コード: 60 秒（README.md:317 / threat-model.md:155,386）", () => {
    expect(TokenLifetime.authorizationCodeMs).toBe(60 * 1000);
  });

  it("ID Token: 5 分（u18-identity-spec.md:260 / runbook.md §4 各所）", () => {
    expect(TokenLifetime.idTokenMs).toBe(5 * 60 * 1000);
  });

  it("Access Token: 10 分（u18-identity-spec.md:261 / threat-model.md:445）", () => {
    expect(TokenLifetime.accessTokenMs).toBe(10 * 60 * 1000);
  });

  it("セッション: 最大 12 時間（threat-model.md:126,324,923）", () => {
    expect(TokenLifetime.sessionMs).toBe(12 * 60 * 60 * 1000);
  });

  it("メール OTP: 5 分（u18-identity-spec.md:263）", () => {
    expect(TokenLifetime.emailOtpMs).toBe(5 * 60 * 1000);
  });
});

describe("OtpPolicy —— 文書が引用する試行・再送の上限", () => {
  it("コードは 6 桁 = 10^6 通り（threat-model.md:128,282）", () => {
    expect(OtpPolicy.codeLength).toBe(6);
  });

  it("試行上限は 5 回（u18-identity-spec.md の決定 13 の節）", () => {
    expect(OtpPolicy.maxAttempts).toBe(5);
  });

  it("持続側はアドレス単位・1 時間窓（u18-identity-spec.md の決定 13 の節）", () => {
    expect(OtpPolicy.resendWindowMs).toBe(60 * 60 * 1000);
  });
});
