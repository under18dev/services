import { describe, expect, it } from "vitest";
import { startOfWindow } from "./helpers";

/**
 * `startOfWindow` が守る不変条件（#176）。
 *
 * **この関数は共有になったので、意味を固定しておく。** 呼ぶ側は
 * 「返った直後から `marginMs` のあいだは窓が切り替わらない」ことに
 * 寄りかかってテストを書く。そこが崩れると、**寄りかかっている側が
 * 時々落ちる**という形で出る —— 原因がこの関数にあるとは分からない。
 *
 * 壁時計を使うので、`period` を 1 秒にして実時間で確かめる。
 */
describe("startOfWindow", () => {
  const remainingMs = (periodSeconds: number): number => {
    const period = periodSeconds * 1_000;
    return period - (Date.now() % period);
  };

  it("返った直後の残り時間が marginMs 以上ある", async () => {
    // 1 秒窓・400ms の余裕で 12 回。窓の位置は呼ぶたびに違うので、
    // **待つ側と待たない側の両方を通る。**
    for (let i = 0; i < 12; i += 1) {
      await startOfWindow(1, 400);
      expect(remainingMs(1), `${i} 回目`).toBeGreaterThanOrEqual(400);
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
  });

  it("余裕が足りているときは待たない", async () => {
    // 窓の頭へ寄せてから、ごく小さい margin で呼ぶ。待つ必要が無いので
    // すぐ返るはず。**「常に待つ」実装でも上のテストは通る**ので、
    // ここが無いと無駄に待つ実装を見逃す。
    await startOfWindow(1, 900);
    const before = Date.now();
    await startOfWindow(1, 10);
    expect(Date.now() - before).toBeLessThan(50);
  });

  it("marginMs を省略すると 1 秒ぶんを確保する", async () => {
    // **境界の直前に自分で立ってから呼ぶ。** そうしないと検査にならない
    // —— 60 秒窓で「残りが 1 秒以上」を見ても、既定が 0 でも 98% 通る
    // （最初そう書いて、既定を 0 にしても落ちなかった）。
    //
    // 1 秒窓の残り 100ms まで待てば、既定が 1 秒なら**必ず待つ**。
    // 既定が 0 なら待たずに返るので、経過時間で区別がつく。
    while (remainingMs(1) > 100) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const before = Date.now();
    await startOfWindow(1);
    expect(Date.now() - before, "待っていない＝既定の余裕が小さすぎる").toBeGreaterThan(50);
  });
});
