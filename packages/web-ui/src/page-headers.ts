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
