/**
 * User-Agent から、一覧で拾い読みできる短い名前を作る。
 *
 * ## なぜ要約するのか。なぜ元の文字列も残すのか
 *
 * この画面の用途は「身に覚えのない端末を見つけて切る」ことである。
 * 生の User-Agent を並べると 1 件が 2 行になり、**どれが自分のものかを
 * 見分ける作業そのものが重くなる。**
 *
 * かといって要約だけを出すのは危ない。**User-Agent は自己申告の文字列で、
 * 攻撃者は好きな値を送れる。** 「Chrome / macOS」とだけ出すと、その要約が
 * 当たっているかを利用者が確かめる手段が画面から消える。
 *
 * そこで**要約を見出しに、元の文字列をその下に**両方出す。拾い読みは
 * 要約で、確認は元の文字列でできる。解釈できなければ要約は `null` を返し、
 * 呼び出し側は元の文字列を見出しに使う（`sessions-page.tsx`）。
 *
 * ## 判定の順序に意味がある
 *
 * Edge は "Edg/" と "Chrome/" と "Safari/" を全部名乗り、Chrome は
 * "Safari/" を名乗る。**具体的なものから先に見る。** 逆順にすると
 * Edge も Chrome も Safari として出る。
 */

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\//, "Opera"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\//, "Chrome"],
  [/\bChrome\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const PLATFORMS: readonly (readonly [RegExp, string])[] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows NT\b/, "Windows"],
  [/\bMac OS X\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

function firstMatch(
  value: string,
  table: readonly (readonly [RegExp, string])[],
): string | undefined {
  for (const [pattern, label] of table) {
    if (pattern.test(value)) return label;
  }
  return undefined;
}

/**
 * 「Chrome / macOS」のような短い名前。判別できなければ `null`。
 *
 * **片方しか分からないときも `null` を返さない。** 「Windows」だけでも
 * 一覧を絞る役には立つ。
 */
export function summarizeUserAgent(userAgent: string): string | null {
  const browser = firstMatch(userAgent, BROWSERS);
  const platform = firstMatch(userAgent, PLATFORMS);

  if (browser !== undefined && platform !== undefined) return `${browser} / ${platform}`;
  return browser ?? platform ?? null;
}
