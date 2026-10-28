import { Layout } from "@u18/web-ui";
import type { Child, FC } from "hono/jsx";
import {
  GRANTS_PATH,
  LOGIN_PATH,
  OVERVIEW_PATH,
  SESSIONS_PATH,
  STYLESHEET_PATH,
} from "./asset-paths";

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

  /**
   * 取り消しの操作がある画面かどうか。`true` なら `<noscript>` で
   * 「JS が無いとできないこと」を伝える。
   *
   * **出すかどうかを画面側が決める。** 全画面に出すと、取り消しの無い
   * 画面でも「何かができない」と読めてしまう。
   */
  readonly hasRevokeActions?: boolean;

  readonly children?: Child;
};

export const AccountShell: FC<AccountShellProps> = ({
  title,
  current,
  scripts = [],
  hasRevokeActions = false,
  children,
}) => (
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
    {/*
      **取り消しには JS が要る**（決定 16）。ボタンはアイランドが作るので、
      JS が無ければそもそも出ない —— 押しても効かないボタンは置かない。
      代わりに、何ができないかをここで言う。

      **ただし「全部切る」だけは JS 無しでもできる**（#208）。auth-worker の
      ログイン画面に `name="all"` のボタンがあり、ただの form POST で届く。
      ここから案内するのは、**できないことだけを書いて行き止まりにしない**
      ため —— 身に覚えのない端末を見つけた人がこの画面に辿り着いて、
      そこで手が止まるのが一番まずい。

      個別のセッションを選んで切るほうは、いまも JS が要る。`<form>` は
      GET/POST しか出せず、`DELETE .../sessions/:id` を呼べないため。
      粒度を落として「全部切る」なら届く、という形になっている。
    */}
    {hasRevokeActions && (
      <noscript>
        <p class="notice">
          この画面での取り消し操作（ログアウト・削除・連携の解除）には JavaScript
          が必要です。一覧の表示は JavaScript 無しでも行えます。
        </p>
        <p class="notice">
          身に覚えのない端末がある場合は、
          <a href={LOGIN_PATH}>ログイン画面</a>
          から「すべての端末からログアウト」を行えます。こちらは JavaScript 無しでも使えます。
        </p>
      </noscript>
    )}
  </Layout>
);
