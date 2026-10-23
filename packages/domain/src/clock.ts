/**
 * 時刻の抽象。
 *
 * Domain / Application が `Date.now()` を直接呼ぶと期限切れのテストが書けなくなるため、
 * 時刻は Port として注入する。Infrastructure が実時計を、テストが固定時計を与える。
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** テスト用の固定時計。`advance` で任意に時間を進められる。 */
export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(at: Date): void {
    this.current = new Date(at);
  }
}
