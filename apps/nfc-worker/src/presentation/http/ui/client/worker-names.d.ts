/**
 * Worker 側のグローバル名だけをブラウザ側の型検査に与える（#338）。
 *
 * dashboard-worker の同名ファイルと同じ役割。このアイランドは
 * `hc<CardsApiType>` を使い、その型は `cards.routes.ts` 経由で `Env` や
 * `D1Database` に触れるので、**名前が解決できないと型検査が通らない。**
 *
 * かといって `types: ["./worker-configuration.d.ts"]` を足すと、**workerd の
 * グローバル型が DOM の型と衝突する**（あちらに実測が書いてある ——
 * `Response` が `cf` を持つものに解決され、`Element` が HTMLRewriter の
 * ものになる）。
 *
 * **中身を正確に書かない。** このアイランドは binding を 1 つも使わない。
 * 欲しいのは**名前が解決すること**だけで、本物の形を写すと二重管理になり、
 * ずれても誰も気づかない。
 */

declare type Fetcher = unknown;
declare type D1Database = unknown;
declare type D1Result<T = unknown> = {
  readonly results: readonly T[];
  readonly meta: { readonly changes: number; readonly [key: string]: unknown };
};
declare type D1PreparedStatement = unknown;

declare interface Env {
  readonly ENVIRONMENT: string;
  readonly IDENTITY: Fetcher;
  readonly NFC_DB: D1Database;
  readonly AUTH_ISSUER: string;
  readonly SHORT_URL_ORIGIN: string;
  readonly ACCOUNT_ORIGIN: string;
}
