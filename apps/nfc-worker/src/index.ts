import { createContainer } from "./composition/container";
import { createApp } from "./presentation/http/app";

export { NfcAdminDelegatedRPC } from "./presentation/rpc/nfc-admin-delegated.entrypoint";

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
 * **RPC Entrypoint を 1 つだけ公開する**（#382 / #390 決定 16 ③）。
 * `NfcAdminDelegatedRPC` —— admin-worker が他人のカードを操作するための
 * delegated RPC。**束縛してよいのは admin-worker だけ。**
 * admin-worker 側の束縛が入った時点で `scripts/check-service-bindings.mjs`
 * の allow-list に足すこと（いまはまだ束縛が無いので検査対象にも入っていない）。
 * それ以外の Worker へは引き続き開いていない（docs/architecture.md 1.1）。
 */
const app = createApp();

export default {
  fetch: app.fetch,

  /**
   * 保持期限を過ぎたカードイベントを消す（仕様書 §9 Privacy）。
   *
   * **auth-worker の Cron からは回せない。** `u18-nfc` は別の D1 で、
   * auth-worker はその binding を持たない —— 持たせると「nfc-worker が
   * 侵害されても Identity は読めない」という §2.2 の線が逆向きに崩れる。
   * **掃除は D1 の所有者が回す**ので、この Worker に Cron がもう 1 本増える。
   *
   * `waitUntil` には載せない。scheduled ハンドラは返した Promise の完了まで
   * 生存が保証されるので、await して結果をログに出せる
   * （auth-worker の `scheduled` と同じ判断）。
   */
  async scheduled(controller, env, _ctx): Promise<void> {
    const { purgeExpiredEvents, purgeExpiredTaps } = createContainer(env).useCases;

    const eventsResult = await purgeExpiredEvents.execute();
    if (eventsResult.reachedLimit) {
      // 上限に達した＝まだ溜まっている。次回の実行で続きを消す。
      // 毎回出続けるなら、流入が掃除の速度を超えている。
      console.warn(
        JSON.stringify({
          event: "nfc.retention.carried_over",
          cron: controller.cron,
          deleted: eventsResult.deleted,
        }),
      );
    }

    // タップ集計の掃除（#394）。別の Port・別のテーブルなので、
    // 片方が例外にならない限り両方を同じ実行で回す。
    const tapsResult = await purgeExpiredTaps.execute();
    if (tapsResult.reachedLimit) {
      console.warn(
        JSON.stringify({
          event: "nfc.tap_count.carried_over",
          cron: controller.cron,
          deleted: tapsResult.deleted,
        }),
      );
    }
  },
} satisfies ExportedHandler<Env>;
