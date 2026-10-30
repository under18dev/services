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
 * **ここは逆に、定数の値を文書の数字と突き合わせる。** 定数を正しい
 * 理由で変えたら、このテストが落ちて初めて「どの文書を直すか」が
 * 分かる —— それが目的で、落ちること自体は想定済みである。
 *
 * ## 出典の書き方（2026-10-31 に訂正）
 *
 * **最初は `README.md:317` のような行番号で書いていた。** 文書は動く ——
 * 同じ日に `.github/workflows/README.md` と `docs/nfc-cards-operations.md`
 * が別々に編集されていて、**行番号は次の編集で簡単にずれる。**
 *
 * **そして行番号で 8 件引き当てたとき、1 件は中身が外れていた**
 * （`threat-model.md:386` は N-5 の資源枯渇の話で、認可コードの 60 秒とは
 * 無関係だった）。**7/8 が合っている状態のほうが悪い** —— 次に読む人は
 * 1 件ずつ確かめず、全部合っていると見なす（#364 が言う「正しい値が、
 * 間違った対象について正しいと読ませた」と同じ形）。
 *
 * **出典を脅威 ID（`threat-model.md` の `S-1` のような見出し・表の行）か、
 * 仕様書の安定した節名に書き直した。** 脅威 ID は
 * `scripts/check-threat-model-refs.mjs`（#371 / #424）が実在を機械で
 * 守る。**ただし「実在する」と「その節が本当にその数字を言っている」は
 * 別**なので、どの ID を選ぶかは**各節の本文を実際に読んで**決めた ——
 * IDを機械が守っていても、選んだ ID が正しいかは人が確かめるしかない。
 *
 * ## 数えた範囲
 *
 * トークン・コードの長さとエントロピー（セッション / CSRF /
 * `client_secret`）と鍵の種別（ES256）は、**ここでは見ない**:
 *
 * - **セッション / 認可コード / アクセストークン / `client_secret`
 *   のエントロピーは `WebCryptoTokenGenerator.generate()` の既定
 *   （32 バイト = 256bit）1 箇所に揃っており、`web-crypto.ts` の
 *   docblock が既にそれを言っている**（固定する対象が無い）
 * - **ES256 は型で固定されている**（`alg: "ES256"` がリテラル型）
 * - **レート制限（`RateLimitPolicy`）は `test/rate-limit-config.test.ts`
 *   が `wrangler.jsonc` と既に突き合わせている**（コード対設定）。
 *   コード対文書（runbook §13.2）は手で読み比べて一致を確認した
 * - **保持期間（`AuditRetention` / `NfcRetention`）は `retention.test.ts`
 *   がスキーマ側から数えて網羅を固定している。**日数（180 日/2 年）は
 *   手で読み比べて一致を確認した
 * - **`MAX_ISSUE_COUNT` は nfc-worker 側で固定する**
 *   （`apps/nfc-worker/test/card-issue.test.ts`）。定数の置き場所と
 *   同じ Worker に検査を置く —— #365 で nfc-worker 側に寄せている判断
 *   と揃える
 * - **カード ID の長さ・`isCardId()` は #365（94）の範囲。** ここでは
 *   触らない
 */
describe("TokenLifetime —— 文書が引用する寿命", () => {
  it("認可コード: 60 秒（threat-model.md S-1 の緩和策 (3)）", () => {
    expect(TokenLifetime.authorizationCodeMs).toBe(60 * 1000);
  });

  it("ID Token: 5 分（u18-identity-spec.md §5.3 の表。threat-model.md に該当する ID は無い）", () => {
    expect(TokenLifetime.idTokenMs).toBe(5 * 60 * 1000);
  });

  it("Access Token: 10 分（threat-model.md RR-6 の「結果」列）", () => {
    expect(TokenLifetime.accessTokenMs).toBe(10 * 60 * 1000);
  });

  it("セッション: 最大 12 時間（threat-model.md E-3 の攻撃シナリオ）", () => {
    expect(TokenLifetime.sessionMs).toBe(12 * 60 * 60 * 1000);
  });

  it("メール OTP: 5 分（threat-model.md D-1 の緩和策 (4)）", () => {
    expect(TokenLifetime.emailOtpMs).toBe(5 * 60 * 1000);
  });
});

describe("OtpPolicy —— 文書が引用する試行・再送の上限", () => {
  it("コードは 6 桁 = 10^6 通り（threat-model.md D-1 の攻撃シナリオ）", () => {
    expect(OtpPolicy.codeLength).toBe(6);
  });

  it("試行上限は 5 回（threat-model.md D-1 の緩和策 (1)）", () => {
    expect(OtpPolicy.maxAttempts).toBe(5);
  });

  it("持続側はアドレス単位・1 時間窓（threat-model.md D-1 の緩和策 (2)）", () => {
    expect(OtpPolicy.resendWindowMs).toBe(60 * 60 * 1000);
  });
});
