import type { AccountNavCurrent, AccountNavGroup } from "@u18/contracts";
import type { Child, FC } from "hono/jsx";
import { Layout } from "../layout";
import { SidebarItem } from "./sidebar-item";

/**
 * `/account` のサイドバー付き外枠、Kiwa UI 版（#332 / #338）。
 *
 * **このファイルは上流の取り込みではない。** `./README.md` の表に
 * 載っていないものは、このリポジトリで書いたものである。
 *
 * ## 並びも行き先も知らない
 *
 * `nav` と `stylesheet` と `brandHref` を**引数で受け取る。**
 * 持っているのは「サイドバーと本文を横に並べる」という形だけで、
 * **何が並ぶか・どこへ行くかは呼び出し側が決める。**
 *
 * 理由は持ち主が 2 人いることにある。`/account/*` の大半は
 * dashboard-worker が、`/account/nfc` は **nfc-worker** が答える。
 * **アセットのパスは Worker ごとに違う**（それぞれが自分で CSS を
 * 配信している。`asset-paths.ts` を参照）ので、ここで決め打つと
 * 片方が他方のアセットを借りる形になる —— #211 で nfc が踏んで、
 * **画面は描かれるがスタイルだけ当たらない**状態になったのがそれである。
 *
 * 並びの実体は `@u18/contracts` の `ACCOUNT_NAV_GROUPS`。**見た目の
 * 部品がデプロイの構成を抱えないように**、あちらに置いてある。
 *
 * ## 読む CSS は Tailwind の 1 本だけ
 *
 * 手書き CSS（`../styles.ts`）と**同じページに重ねない。** Tailwind の
 * preflight がブラウザ既定を潰し、手書き側はその既定を前提に書かれて
 * いる（`body` の中央寄せ、`h2` の余白）ので、重ねると手書き側が崩れる。
 * `Layout` に渡す `stylesheet` は 1 本で、各 Worker のテストが
 * `<link rel="stylesheet">` がちょうど 1 本であることを見ている。
 *
 * ## インラインの `style` を書かない
 *
 * 本番の CSP は `style-src 'self'` で `'unsafe-inline'` を含まない。
 * `style="..."` はブラウザに破棄されるので、**ローカルでは効いて本番で
 * だけ崩れる**（#320）。
 *
 * ## JS を 1 行も要求しない
 *
 * サイドバーは `<a>` の並びで、開閉も折りたたみも無い。
 */

export type KiwaShellProps = {
  readonly title: string;
  readonly nav: readonly AccountNavGroup[];
  /**
   * ナビの現在地。`undefined` ならサイドバーを出さない（未ログイン時や
   * 障害時の画面）。**行き先が無い状態でナビだけ出すと、押すたびに
   * 同じエラーへ戻る。**
   */
  readonly current?: AccountNavCurrent;
  /** ブランドの行き先。ダッシュボードのホーム。 */
  readonly brandHref: string;
  /**
   * 読み込む Tailwind のスタイルシート。**Worker ごとに違う** ——
   * 既定値を置かないのは、書き忘れたら素の HTML が出るようにして
   * おくため（`Layout` の `stylesheet` と同じ判断）。
   */
  readonly stylesheet: string;
  /** 見出し。ページごとに 1 つ。 */
  readonly heading: string;
  readonly lead?: string;
  readonly children?: Child;
};

type SidebarProps = {
  readonly nav: readonly AccountNavGroup[];
  readonly current: AccountNavCurrent;
  readonly brandHref: string;
};

const Sidebar: FC<SidebarProps> = ({ nav, current, brandHref }) => (
  <nav
    class="shrink-0 border-b border-border px-3 py-5 md:w-64 md:border-r md:border-b-0 md:py-8"
    aria-label="ダッシュボード"
  >
    {/*
      **ホームに居るときはここが現在地である。** ホームは並びの項目では
      なくブランドのリンクなので、`aria-current` を付ける先もここになる。
      付けないと、ホームの画面だけサイドバー全体がどこも現在地でない
      状態になる。
    */}
    <a
      href={brandHref}
      class="mb-6 block px-3 text-xs font-medium tracking-[0.12em] text-foreground-soft uppercase transition-colors hover:text-foreground"
      {...(current === "home" ? { "aria-current": "page" } : {})}
    >
      u18 Identity
    </a>
    {nav.map((group) => (
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

export const KiwaShell: FC<KiwaShellProps> = ({
  title,
  nav,
  current,
  brandHref,
  stylesheet,
  heading,
  lead,
  children,
}) => (
  <Layout title={title} frame="bare" stylesheet={stylesheet}>
    <div class="flex min-h-dvh flex-col md:flex-row">
      {current !== undefined && <Sidebar nav={nav} current={current} brandHref={brandHref} />}
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
