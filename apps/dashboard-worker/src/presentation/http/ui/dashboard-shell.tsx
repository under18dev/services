import { Layout } from "@u18/web-ui";
import type { Child, FC } from "hono/jsx";
import {
  GRANTS_PATH,
  LOGIN_PATH,
  OVERVIEW_PATH,
  PASSKEYS_PATH,
  PROFILE_PATH,
  SESSIONS_PATH,
  STYLESHEET_PATH,
} from "./asset-paths";

/**
 * ダッシュボードの外枠（#308）。
 *
 * **`account-shell.tsx` の置き換えである。** 違いは 1 つで、画面間の移動が
 * 横並びの `.nav` から**カテゴリを持つサイドバー**になった。
 *
 * ## なぜ横並びでは足りなくなったか
 *
 * 項目が 3 つで、全部が「アカウント」の話だったから足りていた。ここへ
 * 「開発」（OAuth クライアント）や「サービス」（NFC）が入ると、
 * **どれが同じ仲間かを示す場所が横一列には無い。**
 *
 * ## 中身の無いカテゴリを先に置かない
 *
 * 「サービス」は NFC（#31）が完成してから足す。**押しても何も無いリンクを
 * 置かない** —— パスキーの登録ボタンが「API はあるのに入口が無い」まま
 * 残っていた #306 と、向きは逆だが同じ種類の嘘になる。
 */

export type DashboardNavKey = "home" | "profile" | "passkeys" | "sessions" | "grants" | "clients";

type NavItem = { readonly key: DashboardNavKey; readonly href: string; readonly label: string };
type NavGroup = { readonly label: string; readonly items: readonly NavItem[] };

const ACCOUNT_GROUP: NavGroup = {
  label: "アカウント",
  items: [
    { key: "profile", href: PROFILE_PATH, label: "プロフィール" },
    { key: "passkeys", href: PASSKEYS_PATH, label: "パスキー" },
    { key: "sessions", href: SESSIONS_PATH, label: "ログイン中の端末" },
    { key: "grants", href: GRANTS_PATH, label: "連携アプリ" },
  ],
};

export type DashboardShellProps = {
  readonly title: string;
  /**
   * ナビの現在地。`undefined` ならサイドバーを出さない（未ログイン時や
   * 障害時の画面）。**行き先が無い状態でナビだけ出すと、押すたびに
   * 同じエラーへ戻る。**
   */
  readonly current?: DashboardNavKey;
  /** 見出し。ページごとに 1 つ。 */
  readonly heading: string;
  readonly lead?: string;
  readonly scripts?: readonly string[];
  /**
   * 取り消しの操作がある画面かどうか。`true` なら `<noscript>` で
   * 「JS が無いとできないこと」を伝える。**画面側が決める** —— 全画面に
   * 出すと、取り消しの無い画面でも「何かができない」と読めてしまう。
   */
  readonly hasRevokeActions?: boolean;
  readonly children?: Child;
};

const Sidebar: FC<{ readonly current: DashboardNavKey }> = ({ current }) => (
  <nav class="dash-side" aria-label="ダッシュボード">
    <a class="side-brand" href={OVERVIEW_PATH}>
      u18 Identity
    </a>
    {[ACCOUNT_GROUP].map((group) => (
      <div key={group.label} class="side-group">
        <p class="side-group-label">{group.label}</p>
        <ul class="side-links">
          {group.items.map((item) => (
            <li key={item.key}>
              <a
                class="side-link"
                href={item.href}
                {...(item.key === current ? { "aria-current": "page" } : {})}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    ))}
  </nav>
);

export const DashboardShell: FC<DashboardShellProps> = ({
  title,
  current,
  heading,
  lead,
  scripts = [],
  hasRevokeActions = false,
  children,
}) => (
  <Layout title={title} frame="dash" stylesheet={STYLESHEET_PATH} scripts={scripts}>
    <div class="dash">
      {current !== undefined && <Sidebar current={current} />}
      <main class="dash-main">
        <div class="dash-inner">
          <div class="page-head">
            <h1>{heading}</h1>
            {lead !== undefined && <p>{lead}</p>}
          </div>
          {children}
          {hasRevokeActions && (
            <noscript>
              <p class="notice">
                この画面での取り消し操作（ログアウト・削除・連携の解除）には JavaScript
                が必要です。一覧の表示は JavaScript 無しでも行えます。
              </p>
              <p class="notice">
                身に覚えのない端末がある場合は、<a href={LOGIN_PATH}>ログイン画面</a>
                から「すべての端末からログアウト」を行えます。こちらは JavaScript 無しでも使えます。
              </p>
            </noscript>
          )}
        </div>
      </main>
    </div>
  </Layout>
);
