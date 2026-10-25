/**
 * `Env` と `Fetcher` の名前だけをブラウザ側の型検査に与える。
 *
 * ## なぜ `worker-configuration.d.ts` を読まないのか
 *
 * このアイランドは `hc<DashboardAppType>` を使う。その型は `app.ts` 経由で
 * `Env`（Worker の binding）に触れるので、名前が解決できないと型検査が
 * 通らない。
 *
 * かといって `types: ["./worker-configuration.d.ts"]` を足すと、**workerd の
 * グローバル型が DOM の型と衝突する。** 実測した衝突:
 *
 *  - `Response` —— workerd のもの（`cf` / `webSocket` を持つ）に解決され、
 *    `hc` が返す `ClientResponse` と噛み合わない
 *  - `Element` —— HTMLRewriter の `Element` に解決され、
 *    `element.append(node)` が「`string | Response | ReadableStream` を
 *    渡せ」と言われる
 *
 * **これは auth-worker の `tsconfig.client.json` が避けているものと同じ**で、
 * 向きが逆なだけである（あちらは DOM を Worker 側へ持ち込まない）。
 * 混ざると「動かないコードが型検査を通る」が両方向で起きる。
 *
 * ## 中身を正確に書かない
 *
 * **このアイランドは binding を 1 つも使わない。** 使えば `document` と
 * 同じスコープで Worker の API を呼ぶことになり、それはブラウザでは
 * 存在しない。ここで欲しいのは**名前が解決すること**だけなので、
 * 本物の形を写していない。写すと二重管理になり、ずれても誰も気づかない。
 */

declare type Fetcher = unknown;

declare interface Env {
  readonly ENVIRONMENT: string;
  readonly IDENTITY: Fetcher;
}
