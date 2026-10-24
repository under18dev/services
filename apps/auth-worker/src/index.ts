import { createContainer } from "./composition/container";
import { createApp } from "./presentation/http/app";

export { IdentityRPC } from "./presentation/rpc/identity.entrypoint";

/**
 * auth-worker のエントリポイント。
 *
 * 公開 HTTP（OIDC + アカウント API）と、Service Binding 経由の内部 RPC
 * （`IdentityRPC` の named export）、そして Cron Trigger（`scheduled`）の
 * 3 つの入口を持つ（仕様書 2.1）。
 */
const app = createApp();

export default {
  fetch: app.fetch,

  /**
   * 保持期限を過ぎた行を掃除する（#43、仕様書 7.3）。
   *
   * **掃除の入口はこの 1 本だけにする。** テーブルごとに Cron を分けると、
   * 片方だけ止まっていても誰も気づかない。保持期間の違いは
   * `domain/services/retention-policy.ts` が吸収する。
   *
   * `cron` で分岐していないのは、登録してある Cron 式が 1 つだからである
   * （`wrangler.jsonc` の `triggers.crons`）。式を増やすときはここで分岐させること。
   *
   * `waitUntil` には載せない。scheduled ハンドラは返した Promise の完了まで
   * 生存が保証されるので、await して結果を見たほうが失敗をログに出せる。
   */
  async scheduled(controller, env, _ctx): Promise<void> {
    const { purgeExpiredRecords } = createContainer(env).useCases;
    const result = await purgeExpiredRecords.execute();

    // 例外は投げない。投げると Cron の実行が「失敗」として打ち切られるだけで、
    // 何件消えたかの内訳が失われる。内訳は UseCase 側が構造化ログと
    // 監査ログ（event: "retention.sweep"）に出している。
    if (result.ok && result.value.carriedOver.length > 0) {
      // 上限に達したテーブルがある＝まだ溜まっている。次回の実行で続きを消す。
      // これが毎回出続けるなら、流入が掃除の速度を超えているので
      // Cron の間隔を詰めること（retention-policy.ts の上限の根拠を参照）。
      console.warn("retention sweep carried over", {
        cron: controller.cron,
        carriedOver: result.value.carriedOver,
      });
    }
  },
} satisfies ExportedHandler<Env>;
