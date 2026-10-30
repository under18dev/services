import { NFC_SWEEP_LIMIT, tapCountDeadline } from "../../domain/services/retention-policy";
import type { Clock, ExpiredTapPurger } from "../ports";

export type PurgeExpiredTapsOutput = {
  readonly deleted: number;
  /** 上限に達したか。次回の実行へ持ち越しがある。 */
  readonly reachedLimit: boolean;
};

/**
 * 保持期限を過ぎたタップ集計行を掃除する（#394）。
 *
 * `PurgeExpiredEventsUseCase` と同じ形にしてある——失敗を例外にせず、
 * 件数を構造化ログへ出す。0 件でもログを出すのも同じ理由
 * （止まっていても気づけるように）。
 */
export class PurgeExpiredTapsUseCase {
  constructor(
    private readonly deps: {
      readonly purger: ExpiredTapPurger;
      readonly clock: Clock;
    },
  ) {}

  async execute(limit: number = NFC_SWEEP_LIMIT): Promise<PurgeExpiredTapsOutput> {
    const deadline = tapCountDeadline(this.deps.clock.now());

    let deleted = 0;
    let failed: string | null = null;
    try {
      deleted = await this.deps.purger.purge(deadline, limit);
    } catch (cause) {
      failed = cause instanceof Error ? cause.name : "unknown";
    }

    console.info(
      JSON.stringify({
        event: "nfc.tap_count.sweep",
        deleted,
        limit,
        failed,
        deadline,
      }),
    );

    return { deleted, reachedLimit: deleted >= limit };
  }
}
