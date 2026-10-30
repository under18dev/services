import type { Child, FC } from "hono/jsx";
import { Layout } from "../layout";

/**
 * 中央に 1 枚のカードを置く外枠、Kiwa UI 版（#332 の P2）。
 *
 * **`Layout` が骨格を選んでいた頃の `frame="card"` を引き取ったもの。**
 * あちらは手書き CSS の `.card` / `.brand` に依っていたので、Tailwind だけを
 * 読む画面では使えなかった。手書き CSS が消えたいま、骨格を組むのは
 * 外枠のコンポーネントだけで、`Layout` は `<head>` を受け持つ。
 *
 * 使うのは**入力が 1 つで完結する画面** —— ログイン、新規登録、確認コード、
 * 同意。一覧が縦に伸びる画面はサイドバー付きの `KiwaShell` のほう。
 *
 * ## ブランドを出す
 *
 * `KiwaShell` はサイドバーが自分のブランドを持つので外枠では描かないが、
 * **こちらは外にナビが無い。** 「どのサイトのログイン画面に居るのか」が
 * 読めないと、偽のログイン画面と区別する手掛かりが 1 つ減る。
 *
 * ## インラインの `style` を書かない
 *
 * 本番の CSP は `style-src 'self'` で `'unsafe-inline'` を含まない。
 * `style="..."` はブラウザに破棄されるので、**ローカルでは効いて本番で
 * だけ崩れる**（#320）。
 */

export type KiwaCardShellProps = {
  readonly title: string;
  /**
   * 読み込む Tailwind のスタイルシート。**Worker ごとに違う** ——
   * 既定値を置かないのは、書き忘れたら素の HTML が出るようにしておく
   * ため（`Layout` の `stylesheet` と同じ判断）。
   */
  readonly stylesheet: string;
  /** 読み込む外部スクリプト。インラインは CSP が禁じている。 */
  readonly scripts?: readonly string[];
  readonly children?: Child;
};

export const KiwaCardShell: FC<KiwaCardShellProps> = ({
  title,
  stylesheet,
  scripts = [],
  children,
}) => (
  <Layout title={title} stylesheet={stylesheet} scripts={scripts}>
    <div class="flex min-h-dvh items-center justify-center px-5 py-10">
      <main class="flex w-full max-w-md flex-col gap-5 rounded-xl border border-border bg-card p-8">
        <p class="text-xs font-medium tracking-[0.12em] text-foreground-soft uppercase">
          u18 Identity
        </p>
        {children}
      </main>
    </div>
  </Layout>
);
