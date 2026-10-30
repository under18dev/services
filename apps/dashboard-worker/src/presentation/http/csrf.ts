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
 * **仕組みは `@u18/web-ui` の `csrf.ts` にあり、auth-worker と同じものである。**
 * ここは `Context` から Cookie とヘッダを取り出す adapter だけ。
 *
 * ## なぜ form が 1 本も無いうちに入れるのか
 *
 * **この Worker には form POST がまだ 1 本も無い。** いま守っているものは
 * 無い。それでも先に入れるのは、`app.ts` の `Referrer-Policy` と同じ判断で
 * ある —— あちらのコメントはこう書いてある。
 *
 * > **この Worker にはまだ form POST が無いので、いまは壊れていない。**
 * > それでも揃えるのは、無事である理由が「form がまだ無い」ことだけだから
 * > である。
 *
 * 1 本目の form と一緒に入れると、**移植と新機能のどちらが壊したのか
 * 分からなくなる。** 土台だけを先に、単独で入れる。
 *
 * **1 本目が通らずに済む形にはしてある** —— `test/form-csrf.test.ts` が
 * この Worker の `src` から form と本文読みを数え、**guard を通っていない
 * ものがあれば落ちる。** 書く人が覚えていなくても効く（#253）。
 *
 * ## JSON API の判定（`app.ts` の `hasTrustedOrigin`）とは別物である
 *
 * あちらは `Origin` の一致だけを見る。`fetch` の POST にブラウザは必ず
 * Origin を付けるので、それで足りるうえ、**緩める理由が無いところを
 * 緩めない。** form は Origin の付き方がブラウザ・設定に依存するため、
 * `Sec-Fetch-Site` の救済とトークンの二重が要る（共有側の JSDoc）。
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
 */
export function ensureCsrfToken(c: Context<AppBindings>): string {
  const existing = getCookie(c, cookieName(c));
  if (existing !== undefined && existing.length > 0) return existing;

  const token = generateCsrfToken();
  c.header("Set-Cookie", buildCsrfCookie(c.env.ENVIRONMENT, token), { append: true });
  return token;
}

/**
 * トークンを作り直す。**権限が変わる**瞬間に呼ぶ。
 *
 * この Worker にログイン・ログアウトは無い（auth-worker 側にある）ので、
 * いま呼ぶ場所は無い。**置いてあるのは、auth-worker と同じ API にして
 * おくため** —— 片方にしか無い関数があると、移すときに「こちらには
 * 要らなかったのか、忘れたのか」が読めなくなる。
 *
 * **呼ぶ前に `@u18/web-ui` の `buildCsrfCookie` の JSDoc を読むこと。**
 * 置き場所を間違えると壊れる形が 2 つある —— 同じ応答で画面を描くと
 * **描く値と Cookie がずれて、次の POST が必ず 403 になる**（利用者から
 * 見ると #226 と同じ「何度やっても受け付けられない」）。GET のハンドラに
 * 置くと**第三者のページから `<img src>` ひとつで被害者の Cookie を
 * 回せる**（開いている form がすべて無効になる）。
 *
 * **auth-worker にその規律があるわけではない** —— あちらは呼び出し 3 箇所が
 * たまたますべて `isValidCsrf` を通過した POST の後にある。この Worker では
 * `vitest.config.ts` の走査が「GET のハンドラで呼んでいないこと」を見る
 * （`test/form-csrf.test.ts`）。**文書に書く形は守られない**（#253）。
 */
export function rotateCsrfToken(c: Context<AppBindings>): void {
  const token = generateCsrfToken();
  c.header("Set-Cookie", buildCsrfCookie(c.env.ENVIRONMENT, token), { append: true });
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
      // 比較の相手は自分自身。auth-worker は `ISSUER` を使うが、この Worker は
      // 設定値を持たない —— **持たせると「設定を間違えると全件 403」が
      // 1 つ増える。**
      new URL(c.req.url).origin,
    ),
    expected: getCookie(c, cookieName(c)),
    submitted,
    // **`audit_logs` には書かない。** 弾いたリクエスト 1 本ごとに D1 へ
    // 書くと、攻撃者が書き込みを誘発できる（auth-worker の
    // `audit-log.port.ts` の `csrf.rejected` と同じ判断）。この Worker は
    // そもそも D1 を持たないので、出力先は Workers のログしかない。
    event: "csrf.rejected",
    path: new URL(c.req.url).pathname,
    origin: c.req.header("Origin") ?? null,
    secFetchSite: c.req.header("Sec-Fetch-Site") ?? null,
  });
}
