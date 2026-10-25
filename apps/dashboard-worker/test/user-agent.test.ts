import { describe, expect, it } from "vitest";
import { summarizeUserAgent } from "../src/presentation/http/ui/user-agent";

/**
 * User-Agent の要約（`ui/user-agent.ts`）。
 *
 * **要約を間違えても画面は壊れない** —— 元の文字列を必ず併記しているため
 * （`sessions-page.tsx`）。ここで固定したいのは「よく使われるブラウザを
 * 取り違えないこと」だけである。
 */
describe("よくある User-Agent を取り違えない", () => {
  it.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "Chrome / macOS",
    ],
    [
      // Safari は Chrome と違い Version/ を名乗る。これが無いものは Safari ではない。
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
      "Safari / macOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      // iPhone を先に見る。Mac OS X も含むので、順序を逆にすると macOS になる。
      "Safari / iPhone",
    ],
    [
      // Edge は Chrome も Safari も名乗る。順序を逆にすると Chrome になる。
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      "Edge / Windows",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
      "Firefox / Windows",
    ],
    [
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
      // Android を Linux より先に見る。Android の UA は Linux も含む。
      "Chrome / Android",
    ],
  ])("%s", (ua, expected) => {
    expect(summarizeUserAgent(ua)).toBe(expected);
  });

  it("片方しか分からなくても捨てない", () => {
    // 「Windows」だけでも一覧を絞る役には立つ。
    expect(summarizeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows");
  });

  it("まったく判別できなければ null", () => {
    // 呼び出し側は元の文字列を見出しに使う。
    expect(summarizeUserAgent("curl/8.7.1")).toBeNull();
    expect(summarizeUserAgent("")).toBeNull();
  });
});
