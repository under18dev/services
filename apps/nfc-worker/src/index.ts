import { createApp } from "./presentation/http/app";

/**
 * nfc-worker のエントリポイント（仕様書 10 / Phase 4）。
 *
 * 2 つの入口を 1 つの Worker で受ける。
 *
 *  - `GET https://go.under18.dev/c/<card-id>` 公開の短縮 URL。認証しない。
 *  - `https://auth.under18.dev/account/nfc/cards/*` 管理 API。セッション必須。
 *
 * 分けなかったのは、どちらも同じ `nfc_cards` を見るためで、
 * Worker を割るとこの 1 つのテーブルに対する binding が 2 つに増える。
 * Worker の分割はユースケース上の信頼境界で行う（仕様書 2.2 の設計原則 1）。
 *
 * **RPC Entrypoint を公開しない。** NFC のデータを他の Worker へ
 * 開く必要がまだ無いので、`WorkerEntrypoint` を export しない。
 * Service Binding は「使える API」ではなく「侵害時に届く範囲」なので、
 * 要求が出るまで作らない（docs/architecture.md 1.1）。
 */
const app = createApp();

export default app satisfies ExportedHandler<Env>;
