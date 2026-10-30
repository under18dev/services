/**
 * 画面に出す日時の整形。
 *
 * **`apps/dashboard-worker/.../format.ts` と同じもの。** 共有の package に
 * 出していないのは、中身が `Intl.DateTimeFormat` 1 つの薄い関数で、
 * 依存関係を増やすほどの行数ではないため（`nfc-tap-url.ts` と同じ判断）。
 *
 * ## 固定で JST に落とす
 *
 * RPC が返すのは ISO 8601 (UTC) の文字列である。そのまま出すと
 * `2026-10-25T11:03:22.000Z` になり、読みづらい。**閲覧者のタイムゾーンでは
 * 出していない。** それには JS が要り、この画面は JS 無しで成立させている。
 * u18 の運営は日本国内を想定しているので、`Asia/Tokyo` 固定にして「JST」と
 * 明記する。
 *
 * ## 壊れた値は捨てずにそのまま出す
 *
 * 解釈できない文字列が来たら、例外にせず**元の文字列を返す**。日時が 1 つ
 * 読めないだけで画面全体が 500 になると、失効のような「いま止めたい」操作
 * そのものが行えなくなる。
 */

const FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatDateTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${FORMATTER.format(at)} JST`;
}
