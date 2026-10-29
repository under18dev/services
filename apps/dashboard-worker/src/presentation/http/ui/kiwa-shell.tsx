import { Layout } from "@u18/web-ui";
import { SidebarItem } from "@u18/web-ui/kiwa";
import type { Child, FC } from "hono/jsx";
import { KIWA_STYLESHEET_PATH, OVERVIEW_PATH } from "./asset-paths";
import { DASHBOARD_NAV_GROUPS } from "./dashboard-nav";
import type { DashboardNavKey } from "./dashboard-nav";

/**
 * ダッシュボードの外枠、Kiwa UI 版（#332 の P0）。
 *
 * **`DashboardShell` を置き換えるものだが、まだ置き換えていない。**
 * いま通っているのは `/account/apps` の 1 枚だけで、残り 5 枚は手書き
 * CSS のままである。見本を 1 枚だけ本番と同じ経路に載せて、
 * **Tailwind のビルド・取り込み・ハッシュ・配信が最後まで繋がること**を
 * 確かめるのが P0 の目的で、画面を全部移すのは P1 の仕事。
 *
 * ## P1 で `packages/web-ui` へ移るときに引っかかるところ
 *
 * NFC の画面（#338）が nfc-worker から同じ外枠を読むので、この
 * コンポーネントは packages 側へ移る見込みである。**そのまま移せない** ——
 * ここは `./asset-paths` と `./dashboard-nav` を直接読んでいて、
 * どちらも dashboard-worker の中にある。**パスは Worker ごとに違う**
 * （nfc-worker の `/account/nfc` は別の Worker が配信している）ので、
 * 移すときは `stylesheet` と並びを**引数で受け取る形**にすること。
 * いま直接読んでいるのは、使う側が 1 つしか無いあいだの近道である。
 *
 * ## 読む CSS が `DashboardShell` と違う
 *
 * こちらは `kiwa.<hash>.css`（Tailwind）だけを読む。**両方は読まない** ——
 * 理由は `asset-paths.ts` の `KIWA_STYLESHEET_ROUTE` に書いてある
 * （preflight が手書き側の前提を潰す）。
 *
 * ## インラインの `style` を書かない
 *
 * 本番の CSP は `style-src 'self'` で `'unsafe-inline'` を含まない。
 * `style="..."` はブラウザに破棄されるので、**ローカルでは効いて本番で
 * だけ崩れる**（#320）。Tailwind に移ったあとも事情は同じで、
 * `test/ui-pages.test.ts` が全画面を見ている。
 *
 * ## JS を 1 行も要求しない
 *
 * サイドバーは `<a>` の並びで、開閉も折りたたみも無い。
 * `@kiwa-ui/enhance` を入れていないのはそのためで、**入れるなら
 * 「無効でも機能が消えない」形に限る**（#332 の「守るもの」）。
 */

export type KiwaShellProps = {
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
  readonly children?: Child;
};

const Sidebar: FC<{ readonly current: DashboardNavKey }> = ({ current }) => (
  <nav
    class="shrink-0 border-b border-border px-3 py-5 md:w-64 md:border-r md:border-b-0 md:py-8"
    aria-label="ダッシュボード"
  >
    <a
      href={OVERVIEW_PATH}
      class="mb-6 block px-3 text-xs font-medium tracking-[0.12em] text-foreground-soft uppercase transition-colors hover:text-foreground"
    >
      u18 Identity
    </a>
    {DASHBOARD_NAV_GROUPS.map((group) => (
      <div key={group.label} class="mb-6 last:mb-0">
        <p class="mb-2 px-3 text-xs font-medium text-foreground-soft">{group.label}</p>
        <ul class="flex flex-col gap-0.5">
          {group.items.map((item) => (
            <li key={item.key}>
              <SidebarItem
                href={item.href}
                active={item.key === current}
                {...(item.key === current ? { "aria-current": "page" } : {})}
              >
                {item.label}
              </SidebarItem>
            </li>
          ))}
        </ul>
      </div>
    ))}
  </nav>
);

export const KiwaShell: FC<KiwaShellProps> = ({ title, current, heading, lead, children }) => (
  <Layout title={title} frame="bare" stylesheet={KIWA_STYLESHEET_PATH}>
    <div class="flex min-h-dvh flex-col md:flex-row">
      {current !== undefined && <Sidebar current={current} />}
      <main class="min-w-0 flex-1 px-5 py-8 md:px-10 md:py-12">
        <div class="mx-auto flex w-full max-w-3xl flex-col gap-8">
          <div class="flex flex-col gap-2">
            <h1 class="text-2xl">{heading}</h1>
            {lead !== undefined && <p class="text-sm/relaxed text-foreground-muted">{lead}</p>}
          </div>
          {children}
        </div>
      </main>
    </div>
  </Layout>
);
