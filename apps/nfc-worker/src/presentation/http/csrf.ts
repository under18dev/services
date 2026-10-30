import {
  buildCsrfCookie,
  csrfCookieName as sharedCsrfCookieName,
  generateCsrfToken,
  isTrustedOrigin,
  isValidCsrf as isValidCsrfCheck,
} from "@u18/web-ui";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppBindings } from "./types";

/**
 * form POST 用の CSRF 対策（仕様書 9 CSRF）。
 *
 * **仕組みは `@u18/web-ui` の `csrf.ts` にあり、auth-worker・dashboard-worker と
 * 同じものである。** ここは `Context` から Cookie とヘッダを取り出す adapter だけ。
 *
 * ## なぜ form POST を 1 本入れるのか（#358）
 *
 * この Worker の書き込みは長らく JSON + Origin 検証だけで、`cards-page.tsx` は
 * **「書き込み経路を 2 本（form POST と JSON）持たない」**と宣言していた。
 * その判断は遷移先の変更については今も正しい —— JavaScript 無しで使えなくても、
 * **一覧は読める**。
 *
 * **紐づけは違う。** カードをタップした人が最初に通る経路で、しかも
 * **アカウントがまだ無い人が通る。** ここを JavaScript 必須にすると、
 * JS が落ちている利用者は「タップはできるが自分のものにはできない」になる。
 * ノベルティとして配る前提（#358 の運用者の判断）で、それは成立しない。
 *
 * **JSON API 側の `POST /cards/claim` も残してある**が、検証は両方とも
 * `ClaimCardUseCase` と WHERE 句にあるので、**2 箇所で同期させ続ける対象は
 * 本文の読み方だけ**である。
 *
 * ## 走査テストはまだ無い
 *
 * dashboard-worker は `vitest.config.ts` が `src` から form と本文読みを数え、
 * **guard を通っていないものがあれば落ちる**（`test/form-csrf.test.ts`、#253）。
 * **この Worker には移植していない。** いま form は 1 本しか無く、その 1 本は
 * `test/claim.form.test.ts` が直接見ている。
 *
 * **2 本目の form を足す人へ: 先にあの走査を移植すること（#363）。**
 *
 * 「文書に書く形は守られない」というのが #253 の結論で、**この段落も文書である。**
 * だから #363 を立ててある —— **コメントはこのファイルを開いた人にしか効かず、
 * 2 本目を足す人はここを開かずに別のファイルへ form を書ける。**
 */

export { CSRF_FIELD_NAME } from "@u18/web-ui";

function cookieName(c: Context<AppBindings>): string {
  return sharedCsrfCookieName(c.env.ENVIRONMENT);
}

/**
 * 画面を描くときに CSRF トークンを用意する。
 *
 * **既にある Cookie を使い回す。** 描画のたびに作り直すと、タブを 2 つ開いた
 * 利用者の古いほうが必ず 403 になる。
 *
 * **作り直す関数（`rotateCsrfToken`）はここに置いていない。** この Worker に
 * 権限が変わる瞬間（ログイン・ログアウト）は無く、置くと**GET のハンドラで
 * 呼ばれる余地**だけが増える。共有側の `buildCsrfCookie` の JSDoc に、
 * それが第三者のページから `<img src>` ひとつで踏める話が書いてある。
 */
export function ensureCsrfToken(c: Context<AppBindings>): string {
  const existing = getCookie(c, cookieName(c));
  if (existing !== undefined && existing.length > 0) return existing;

  const token = generateCsrfToken();
  c.header("Set-Cookie", buildCsrfCookie(c.env.ENVIRONMENT, token), { append: true });
  return token;
}

/**
 * form POST を受け取ってよいかを判定する。
 *
 * Origin とトークンの**両方**を要求する。片方でも欠けたら拒否する。
 */
export function isValidCsrf(c: Context<AppBindings>, submitted: string | undefined): boolean {
  return isValidCsrfCheck({
    originAllowed: isTrustedOrigin(
      c.req.header("Origin"),
      c.req.header("Sec-Fetch-Site"),
      // 比較の相手は自分自身。設定値を持たせると「設定を間違えると全件 403」が
      // 1 つ増える（dashboard-worker と同じ判断）。
      new URL(c.req.url).origin,
    ),
    expected: getCookie(c, cookieName(c)),
    submitted,
    // **`nfc_card_events` には書かない。** 弾いたリクエスト 1 本ごとに D1 へ
    // 書くと、攻撃者が書き込みを誘発できる。出力先は Workers のログだけ。
    event: "csrf.rejected",
    // **`pathname` だけ。`search` を足さないこと** —— 紐づけ画面は
    // カード ID をクエリで受け取る（`base-path.ts` の `CLAIM_CARD_PARAM`）。
    // 足すと、拒否のログ 1 行が未紐づけカードの持ち出しになる。
    path: new URL(c.req.url).pathname,
    origin: c.req.header("Origin") ?? null,
    secFetchSite: c.req.header("Sec-Fetch-Site") ?? null,
  });
}
