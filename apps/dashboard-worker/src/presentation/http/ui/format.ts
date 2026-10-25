/**
 * 画面に出す日時の整形。
 *
 * ## 固定で JST に落とす
 *
 * RPC が返すのは ISO 8601 (UTC) の文字列である。そのまま出すと
 * `2026-10-25T11:03:22.000Z` になり、「この端末はいつからログインしているか」
 * を読む用途には向かない。
 *
 * **閲覧者のタイムゾーンでは出していない。** それには JS が要り、この画面は
 * JS 無しで成立させている（決定 4 の延長）。u18 の利用者は日本国内を
 * 想定しているので、`Asia/Tokyo` 固定にして「JST」と明記する。
 * 海外から見る利用者には一貫してずれるが、**どのタイムゾーンで表示されて
 * いるか分からない**よりは読める。
 *
 * ## 壊れた値は捨てずにそのまま出す
 *
 * 解釈できない文字列が来たら、例外にせず**元の文字列を返す**。日時が 1 つ
 * 読めないだけで画面全体が 500 になると、セッションの失効という
 * **「怪しいから今すぐ切りたい」操作そのものが行えなくなる。**
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
