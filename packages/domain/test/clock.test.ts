import { describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock";

describe("FixedClock", () => {
  it("時間を進められる", () => {
    const clock = new FixedClock(new Date("2026-10-24T00:00:00.000Z"));
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe("2026-10-24T00:01:00.000Z");
  });

  it("返した Date を書き換えても内部状態に影響しない", () => {
    const clock = new FixedClock(new Date("2026-10-24T00:00:00.000Z"));
    clock.now().setFullYear(2000);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});
