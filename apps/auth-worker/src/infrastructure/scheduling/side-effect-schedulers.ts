import type { SideEffectScheduler } from "../../application/ports/side-effect-scheduler.port";
import { settleSideEffects } from "../../application/use-cases/side-effects";

/**
 * その場で待つ（#126 以前の挙動）。
 *
 * `ExecutionContext` が無い経路で使う —— Cron の `scheduled` は返した
 * Promise の完了まで生存が保証されるので、待って結果をログに出すほうがよい。
 */
export class InlineSideEffectScheduler implements SideEffectScheduler {
  schedule(label: string, ...tasks: readonly Promise<unknown>[]): Promise<void> {
    return settleSideEffects(label, ...tasks);
  }
}

/**
 * 応答を返した後へ逃がす（#126 / 脅威モデル RR-15）。
 *
 * `waitUntil` に渡した Promise は、応答を返した後も完了まで isolate を
 * 生かす。**応答時間には乗らない**ので、監査ログの INSERT が有るか無いかで
 * 経路を見分けられなくなる。
 *
 * `settleSideEffects` を内側で通すのは、`waitUntil` に渡した Promise が
 * reject すると Workers が「未処理の拒否」として扱うため。失敗は飲み込んで
 * ログにだけ残す、という契約はここでも同じ。
 */
export class WaitUntilSideEffectScheduler implements SideEffectScheduler {
  constructor(private readonly waitUntil: (task: Promise<unknown>) => void) {}

  async schedule(label: string, ...tasks: readonly Promise<unknown>[]): Promise<void> {
    this.waitUntil(settleSideEffects(label, ...tasks));
  }
}
