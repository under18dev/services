import {
  RETENTION_SWEEP_LIMIT,
  RetentionPolicy,
  type RetentionTarget,
  retentionCutoff,
} from "../../domain/services/retention-policy";
import { auditEventDeadlines, type AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { ExpiredRecordPurger, PurgeResult } from "../ports/retention.port";
import { settleSideEffects } from "./side-effects";
import { ok, type UseCaseResult } from "./types";

/** 掃除の対象。`RetentionPolicy` のキーをそのまま順に回す。 */
const TARGETS = Object.keys(RetentionPolicy) as readonly RetentionTarget[];

export type PurgeExpiredRecordsCommand = {
  /** 1 テーブルあたりの上限。既定は `RETENTION_SWEEP_LIMIT`。 */
  readonly limit?: number;
};

export type PurgeExpiredRecordsOutput = {
  readonly deleted: number;
  /** 上限に達したテーブル。空でなければ、次回の実行に持ち越しが残っている。 */
  readonly carriedOver: readonly RetentionTarget[];
  readonly results: readonly PurgeResult[];
  /** 削除に失敗したテーブル。1 つ失敗しても残りは続行する。 */
  readonly failed: readonly RetentionTarget[];
};

export type PurgeExpiredRecordsDeps = {
  readonly purger: ExpiredRecordPurger;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * 保持期限を過ぎた行を掃除する（#43、仕様書 7.3）。
 *
 * **これが唯一の掃除経路である。** テーブルごとに Cron やハンドラを分けると、
 * 片方だけ止まっていても誰も気づかない。保持期間はテーブルごとに違ってよいが、
 * 実行経路は 1 本に保ち、1 回の実行で全テーブルを順に見る。
 *
 * 設計上の約束が 3 つある。
 *
 * 1. **1 テーブルが落ちても残りを続ける。** D1 が 1 テーブルで失敗したからと
 *    いって他のテーブルが溜まり続けるのは割に合わない。失敗は記録して次へ進む。
 * 2. **直列に回す。** 6 本の `delete` を同時に投げると、掃除自身が D1 への
 *    突発的な負荷になる。掃除は遅れても困らない処理なので、急がない。
 * 3. **必ず結果を残す。** 黙って動く掃除は、止まっていても気づけない
 *    （この issue の出発点がまさにそれ）。件数を監査ログと構造化ログの
 *    両方に出す。監査ログ側が書けなくても Workers のログには残る。
 */
export class PurgeExpiredRecordsUseCase {
  constructor(private readonly deps: PurgeExpiredRecordsDeps) {}

  async execute(
    command: PurgeExpiredRecordsCommand = {},
  ): Promise<UseCaseResult<PurgeExpiredRecordsOutput>> {
    const limit = command.limit ?? RETENTION_SWEEP_LIMIT;
    const now = this.deps.clock.now();

    const results: PurgeResult[] = [];
    const failed: RetentionTarget[] = [];

    for (const target of TARGETS) {
      try {
        results.push(
          await this.deps.purger.purge({
            target,
            deadBefore: retentionCutoff(now, target),
            limit,
            // `audit_logs` だけイベントごとに保持期間が変わる（#22）。
            // 他のテーブルには渡さない —— 渡しても無視されるが、
            // 「このテーブルも区分がある」と読めてしまう。
            eventDeadlines: target === "audit_logs" ? auditEventDeadlines(now) : undefined,
          }),
        );
      } catch (cause) {
        // 1 テーブルの失敗で掃除全体を止めない（約束 1）。
        failed.push(target);
        console.error("retention sweep failed", { target, cause });
      }
    }

    const deleted = results.reduce((sum, result) => sum + result.deleted, 0);
    const carriedOver = results.filter((r) => r.reachedLimit).map((r) => r.target);

    // 件数の内訳。テーブル名をキーにしておくと、ログ検索でそのまま絞り込める。
    const byTarget = Object.fromEntries(results.map((r) => [r.target, r.deleted]));

    // 構造化ログ。0 件でも必ず出す。「最後にいつ掃除が走ったか」を
    // 件数ではなくログの有無で判断できるようにするため。
    console.info("retention sweep", { deleted, byTarget, carriedOver, failed, limit });

    await settleSideEffects(
      "retention.sweep",
      this.deps.audit.record({
        event: "retention.sweep",
        actor: "cron",
        outcome: failed.length === 0 ? "success" : "failure",
        reason: failed.length === 0 ? undefined : "purge_failed",
        // 消したのは行数だけで、消した内容は書かない（仕様書 9 Privacy）。
        metadata: { deleted, byTarget, carriedOver, failed, limit },
      }),
    );

    // 失敗があっても ok を返す。呼び出し元は Cron で、再試行の判断材料は
    // 例外ではなく `failed` の中身。次回の実行が自然な再試行になる。
    return ok({ deleted, carriedOver, results, failed });
  }
}
