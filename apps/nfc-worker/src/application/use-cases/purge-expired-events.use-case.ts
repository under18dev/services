import {
  NFC_SWEEP_LIMIT,
  nfcEventDeadlines,
  type NfcCardEventName,
} from "../../domain/services/retention-policy";
import type { Clock, ExpiredEventPurger } from "../ports";

export type PurgeExpiredEventsOutput = {
  readonly deleted: number;
  /** 上限に達したか。次回の実行へ持ち越しがある。 */
  readonly reachedLimit: boolean;
};

/**
 * 保持期限を過ぎたカードイベントを掃除する（仕様書 §9 Privacy）。
 *
 * **このテーブルには掃除が 1 つも無かった。** `actor_user_id` を持つ行が
 * 無期限に残る状態だったので、Cron から回す経路をここに作る。
 *
 * ## 失敗しても例外にしない
 *
 * Identity 側の `PurgeExpiredRecordsUseCase` と同じ扱い。Cron の実行が
 * 「失敗」として打ち切られるだけで、何件消えたかの内訳が失われる。
 * 件数は構造化ログへ出す。
 *
 * **0 件でもログを出す。** 黙って動く掃除は、止まっていても気づけない
 * ——「最後にいつ掃除が走ったか」を件数ではなくログの有無で判断できる
 * ようにしておく（#43 の出発点がまさにそれ）。
 */
export class PurgeExpiredEventsUseCase {
  constructor(
    private readonly deps: {
      readonly purger: ExpiredEventPurger;
      readonly clock: Clock;
    },
  ) {}

  async execute(limit: number = NFC_SWEEP_LIMIT): Promise<PurgeExpiredEventsOutput> {
    const now = this.deps.clock.now();
    const deadlines = nfcEventDeadlines(now);

    let deleted = 0;
    let failed: string | null = null;
    try {
      deleted = await this.deps.purger.purge(deadlines, limit);
    } catch (cause) {
      failed = cause instanceof Error ? cause.name : "unknown";
    }

    console.info(
      JSON.stringify({
        event: "nfc.retention.sweep",
        deleted,
        limit,
        failed,
        // どの境界で切ったかを残す。保持期間を変えたとき、いつから効いたかが追える。
        deadlines: Object.fromEntries(
          [...deadlines].map(([event, at]) => [event as NfcCardEventName, at.toISOString()]),
        ),
      }),
    );

    return { deleted, reachedLimit: deleted >= limit };
  }
}
