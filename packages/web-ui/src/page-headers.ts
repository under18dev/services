import { secureHeaders } from "hono/secure-headers";

/**
 * 画面を返す全経路に掛ける CSP。
 *
 * `app.ts` の `secureHeaders()` は既定では CSP を出さない。ここで**足して**いる
 * のであって、既存の設定を緩めてはいない。
 *
 * ## なぜ Worker をまたいで共有するのか
 *
 * ログイン画面・同意画面（auth-worker）とアカウント管理画面
 * （dashboard-worker）は、**同じオリジン `auth.under18.dev` で配信される**
 * （仕様書 §14.1 決定 1。`__Host-` Cookie が Domain 属性を持てないため
 * 同一ホストにパスで分けている）。
 *
 * つまり**どれか 1 つが緩ければ、攻撃者はそこを足がかりに他を狙える。**
 * CSP は「このページが何を読み込んでよいか」であって「このページを誰が
 * 守るか」ではないので、オリジンが同じなら強さも揃っていなければ意味が薄い。
 *
 * 片方を直してもう片方を忘れる余地を作らないために、**Worker をまたいで
 * 定数を 1 つにしてある**（`@u18/web-ui`）。Worker ごとに持つと、
 * デプロイが別なぶん気づくのが遅れる。
 *
 * - `script-src 'self'`: `'unsafe-inline'` も nonce も使わない。そのため
 *   ページにインライン `<script>` を 1 つも置けない。アイランドを外部ファイル
 *   （/ui/login-island.js）として配信しているのはこの制約に合わせるため。
 *   同意画面は JS を 1 行も使わない。
 * - `style-src 'self'`: 同じ理由で `<style>` もインライン `style` 属性も使わない。
 * - `form-action 'self'`: form の送信先を乗っ取られても外部へ飛ばせない。
 *   **認可の同意 form でこれが効く**。同意ボタンの `action` を書き換えられても、
 *   入力した内容が外部のサーバーへ POST されることはない。
 * - `frame-ancestors 'none'`: clickjacking を禁じる（`secureHeaders()` の
 *   X-Frame-Options: SAMEORIGIN より強い）。同意画面を透明な iframe に重ねて
 *   「許可」を押させる攻撃を、ここで塞いでいる。
 * - `default-src 'none'` + `connect-src 'self'`: アイランドの fetch 先を
 *   自オリジンに限る。
 * - `img-src 'self' data:`: クライアントの `logo_url` は**表示しない**ので
 *   外部ホストを許していない。許すと、同意画面を開いた事実が第三者のサーバーに
 *   伝わる（誰がどのアプリを認可しようとしたかが漏れる）。
 *
 * CSP に引っかかったら、ここを緩めるのではなく外部ファイルへ出すこと。
 *
 * ## `Referrer-Policy` は**ここに置かない**
 *
 * `secureHeaders()` の既定は `no-referrer` で、一見するとこれが最も安全に
 * 見える。ところが Fetch 仕様では、**referrer policy が参照元を落とす場合、
 * ナビゲーション要求の `Origin` も `null` になる。** その結果:
 *
 *   POST /signup/start   Origin: null   Sec-Fetch-Site: same-origin   -> 403
 *
 * **自分のページから出した form 送信が、自分で拒否される。** auth-worker が
 * 本番でこれを踏み、ログイン・新規登録・ログアウトが全滅した（#226）。
 *
 * それでも**この定数には `referrerPolicy` を書かない。** 理由が 2 つある。
 *
 * **1. ここに書いても効かない。** 各 Worker の `app.ts` にある全体の
 * `secureHeaders()` が後から上書きする。#226 で実際にここへ書いて効かず、
 * テストで気づいて `app.ts` へ移している。
 *
 * **2. 3 つの Worker で必要な値が違う。** auth-worker と dashboard-worker は
 * form POST（いまの・これからの）のために `same-origin` が要る。一方
 * **nfc-worker は `no-referrer` のままが正しい** —— カードの短縮 URL から
 * 遷移先へ飛ぶとき、遷移先にカード ID を渡さないためである
 * （`apps/nfc-worker/test/redirect.test.ts` がそれを固定している）。
 * 共有の定数に 1 つの値を置くと、どれかが黙って間違う。
 *
 * **値は各 Worker の `app.ts` にある**（`apps/auth-worker` /
 * `apps/dashboard-worker` /`apps/nfc-worker` の
 * `presentation/http/app.ts`）。変えるときはそちらを見ること。
 */
export const pageSecurityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
  },
});
