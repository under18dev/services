import { Layout } from "@u18/web-ui";
import type { Child, FC } from "hono/jsx";
import { GRANTS_PATH, OVERVIEW_PATH, SESSIONS_PATH, STYLESHEET_PATH } from "./asset-paths";

/**
 * アカウント管理画面の外枠。
 *
 * `Layout`（`@u18/web-ui`）に、この Worker 固有のものだけを足している:
 * ページ間のナビと、自分のスタイルシートのパス。**見た目そのものは
 * auth-worker のログイン画面と同じ定義を読む**（仕様書 §14.1 決定 4）。
 */

/** ナビの現在地。`aria-current` に使う。 */
export type AccountNavKey = "overview" | "sessions" | "grants";

const NAV: readonly {
  readonly key: AccountNavKey;
  readonly href: string;
  readonly label: string;
}[] = [
  { key: "overview", href: OVERVIEW_PATH, label: "アカウント" },
  { key: "sessions", href: SESSIONS_PATH, label: "ログイン中の端末" },
  { key: "grants", href: GRANTS_PATH, label: "連携アプリ" },
];

export type AccountShellProps = {
  readonly title: string;
  /**
   * ナビの現在地。`undefined` ならナビを出さない（未ログイン時や
   * 障害時の画面）。**行き先が無い状態でナビだけ出すと、押すたびに
   * 同じエラーへ戻る。**
   */
  readonly current?: AccountNavKey;
  readonly scripts?: readonly string[];
  readonly children?: Child;
};

export const AccountShell: FC<AccountShellProps> = ({ title, current, scripts = [], children }) => (
  <Layout title={title} frame="shell" stylesheet={STYLESHEET_PATH} scripts={scripts}>
    {current !== undefined && (
      <nav class="nav">
        {NAV.map((item) => (
          <a
            key={item.key}
            href={item.href}
            // 現在地を色だけで示さない。`.nav a[aria-current="page"]` が
            // 下線も付ける（styles.ts）。読み上げにもそのまま伝わる。
            aria-current={item.key === current ? "page" : undefined}
          >
            {item.label}
          </a>
        ))}
      </nav>
    )}
    {children}
  </Layout>
);
