import { describe, expect, it } from "vitest";
import { isRemoved } from "../src/presentation/http/ui/client/outcome";

/**
 * 取り消しの応答の畳み方（`client/outcome.ts`）。
 *
 * アイランド本体は DOM を使うので Worker 上の vitest から動かせないが、
 * **判断だけを出してあるので関数として直接確かめられる。**
 * バンドルされた文字列を正規表現で睨む形にすると、**minify の仕方が
 * 変わっただけで壊れるか、あるいは何も確かめていないことになる。**
 */
describe("「消えた」と見なす応答", () => {
  it("2xx は消えた", () => {
    expect(isRemoved({ ok: true, status: 200 })).toBe(true);
  });

  it("404 も消えた扱いにする", () => {
    // **もう無いものを消そうとしただけ。** 利用者から見た結果は同じで、
    // 失敗として見せると「消えていないのでは」ともう一度押させる。
    expect(isRemoved({ ok: false, status: 404 })).toBe(true);
  });

  it.each([401, 403, 409, 500, 503])("%i は消えていない", (status) => {
    // 401 / 403 はやり直せば通る可能性があり、409 は状態の問題、
    // 5xx は届いていない。**どれも「もう効いていない」とは言えない。**
    expect(isRemoved({ ok: false, status })).toBe(false);
  });
});
