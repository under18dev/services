import { APPS_PATH, GRANTS_PATH, PASSKEYS_PATH, PROFILE_PATH, SESSIONS_PATH } from "./asset-paths";

/**
 * ダッシュボードのサイドバーに並ぶもの（#308 / #332）。
 *
 * ## なぜ外に出ているのか
 *
 * **いま外枠が 2 つある。** 手書き CSS の `DashboardShell`（残り 5 枚）と、
 * Kiwa UI の `KiwaShell`（`/account/apps` だけ）。#332 の P0 が「見本を
 * 1 枚だけ組み直す」なので、**移行の途中は必ずこの状態を通る。**
 *
 * 並びを両方に書くと、**片方にだけ項目を足した状態**が作れてしまう。
 * 画面によってサイドバーの中身が違うのは、利用者から見れば
 * 「さっきあった項目が消えた」である。落ちもしないし、どちらの画面も
 * 正しく見えるので、気づく機会が無い。
 *
 * **P1 で `DashboardShell` が退役してもこのファイルは残る。** 外枠が
 * 1 つに戻ったときの置き場所としてもここが正しい（外枠の実装と、
 * 何が並ぶかは別の関心である）。
 *
 * ## 中身の無いカテゴリを先に置かない
 *
 * **押しても何も無いリンクを置かない** —— パスキーの登録ボタンが
 * 「API はあるのに入口が無い」まま残っていた #306 と、向きは逆だが
 * 同じ種類の嘘になる。「開発」（OAuth クライアントの管理）はまだ無い。
 */

export type DashboardNavKey =
  "home" | "profile" | "passkeys" | "sessions" | "grants" | "apps" | "clients";

export type NavItem = {
  readonly key: DashboardNavKey;
  readonly href: string;
  readonly label: string;
};

export type NavGroup = { readonly label: string; readonly items: readonly NavItem[] };

const ACCOUNT_GROUP: NavGroup = {
  label: "アカウント",
  items: [
    { key: "profile", href: PROFILE_PATH, label: "プロフィール" },
    { key: "passkeys", href: PASSKEYS_PATH, label: "パスキー" },
    { key: "sessions", href: SESSIONS_PATH, label: "ログイン中の端末" },
    { key: "grants", href: GRANTS_PATH, label: "連携アプリ" },
  ],
};

/**
 * 「サービス」グループ（#308）。
 *
 * **「アカウント」と分ける。** あちらは「自分の設定をいじる」場所、
 * こちらは「u18 でログインして使う別のアプリへ行く」場所である。
 * 用事が違うものを同じ並びに置くと、どちらを探しているのか決めてから
 * でないと読めない一覧になる。
 */
const SERVICE_GROUP: NavGroup = {
  label: "サービス",
  items: [{ key: "apps", href: APPS_PATH, label: "アプリ" }],
};

/** 表示順。**外枠の実装がどちらでも同じ並びになる。** */
export const DASHBOARD_NAV_GROUPS: readonly NavGroup[] = [ACCOUNT_GROUP, SERVICE_GROUP];
