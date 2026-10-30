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
 * 理由は持ち主が複数いることにある。`/account/*` の大半は
 * dashboard-worker が、`/account/nfc` は **nfc-worker** が答える。
 * さらに `admin.under18.dev` は **admin-worker** が、account とは
 * 別のナビを出す（#390）。**アセットのパスは Worker ごとに違う**
 * （それぞれが自分で CSS を配信している。`asset-paths.ts` を参照）ので、
 * ここで決め打つと片方が他方のアセットを借りる形になる —— #211 で
 * nfc が踏んで、**画面は描かれるがスタイルだけ当たらない**状態に
 * なったのがそれである。
 *
 * `nav`/`current` の型は `ShellNavGroup`/`ShellNavCurrent`（このファイルが
 * 持つ）であって、`@u18/contracts` の `AccountNavGroup`/`AccountNavCurrent`
 * ではない。**account のナビは `AccountNavKey` という閉じた共用体で、
 * admin のナビはそれとは別物**だからである——`AccountNavGroup` は
 * 構造的に `ShellNavGroup` を満たすので、account 側の呼び出しは
 * 変更なしで動く。並びの実体そのもの（`ACCOUNT_NAV_GROUPS` など）は
 * 依然として contracts に置く。**見た目の部品がデプロイの構成を
 * 抱えないように**、という元の理由はそのまま。
 *
 * ## 読む CSS は Tailwind の 1 本だけ
 *
 * `Layout` に渡す `stylesheet` は 1 本で、各 Worker のテストが
 * `<link rel="stylesheet">` がちょうど 1 本であることを見ている。
 * **重ねないための決まりだった** —— かつては手書き CSS（`styles.ts`）が
 * 並んでおり、Tailwind の preflight がその前提（`body` の中央寄せ、
 * `h2` の余白）を潰した。手書き側は #332 で消えたが、**1 本であること
 * 自体は Worker ごとの CSS が混ざらないために要る。**
 *
 * ## インラインの `style` を書かない
 *
 * 本番の CSP は `style-src 'self'` で `'unsafe-inline'` を含まない。
 * `style="..."` はブラウザに破棄されるので、**ローカルでは効いて本番で
 * だけ崩れる**（#320）。
 *
 * ## モバイルの開閉は `<input type="checkbox">` + `peer-checked:`（#399 の作り直し）
 *
 * かつて `<details>`/`<summary>` で作ったことがあるが、**本番の PC で
 * サイドバーが消えた。** 最近のブラウザは `<details>` が閉じている間、
 * 中身を `::details-content` という擬似要素で包み
 * `content-visibility: hidden` を当てる。**子要素に `display: flex` を
 * 指定しても、親の `content-visibility: hidden` には勝てない。**
 * `group-open:` は `[open]` のときしか効かないので、`<summary>` を
 * `md:hidden` にしたことで PC では開く手段ごと消えていた。
 *
 * DOM 構造のテスト（`group-open:flex` が外れると落ちる、まで）は
 * 通っていた。**それでも PC で消えた** —— 「クラスが付いていること」と
 * 「見えること」は別で、**隠しているのが何なのか**（このときは `<nav>`
 * 自身ではなく `<details>` の中身を包む擬似要素）を見ないと分からない。
 *
 * 今回のチェックボックス方式は `::details-content` のような擬似要素を
 * 経由しない —— `peer-checked:` も `md:` も、素の `<div>`/`<nav>` の
 * `display` にしか掛からない。チェックボックス自身は `sr-only`
 * （スクリーンリーダーには残るが見た目には出ない）で、折りたたみの
 * 状態は `<label for>` を押すか、チェックボックスへキーボードで
 * フォーカスして Space を押せば切り替わる —— ここでも JS を 1 行も
 * 要求しない。
 *
 * ## `<noscript>` を出すかは画面が決める
 *
 * `hasRevokeActions` が立っている画面だけが「JS が無いとできないこと」を
 * 出す。**全画面に出すと、取り消しの無い画面でも「何かができない」と
 * 読めてしまう。**
 *
 * **これは外枠が出せる 1 種類だけである。** 画面固有の事情（プロフィール
 * の「表示名の変更には JS が要る」など）は、**その画面が自分で
 * `<noscript>` を書く。** 外枠に種類を増やすと、どの画面が何を出すのかを
 * 外枠が知ることになる。
 */

/** `ShellNavGroup` の 1 項目。`@u18/contracts` の `AccountNavItem` はこれを満たす。 */
export type ShellNavItem = {
  readonly key: string;
  readonly href: string;
  readonly label: string;
};

/** `ShellNavItem` のまとまり。`@u18/contracts` の `AccountNavGroup` はこれを満たす。 */
export type ShellNavGroup = {
  readonly label: string;
  readonly items: readonly ShellNavItem[];
};

/** ナビの現在地を表す文字列。`@u18/contracts` の `AccountNavCurrent` はこの部分型。 */
export type ShellNavCurrent = string;

export type KiwaShellProps = {
  readonly title: string;
  readonly nav: readonly ShellNavGroup[];
  /**
   * ナビの現在地。`undefined` ならサイドバーを出さない（未ログイン時や
   * 障害時の画面）。**行き先が無い状態でナビだけ出すと、押すたびに
   * 同じエラーへ戻る。**
   */
  readonly current?: ShellNavCurrent;
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
  /** 読み込む外部スクリプト。インラインは CSP が禁じている。 */
  readonly scripts?: readonly string[];
  /**
   * 本文の最大幅（Tailwind の `max-w-*` クラス）。既定は `max-w-3xl`。
   *
   * **admin 画面は表が主役で、768px では足りない。** 画面ごとに
   * 必要な幅が違うので、既定値を持つが固定はしない。
   */
  readonly maxWidth?: string;
  /**
   * 取り消しの操作がある画面かどうか。`true` なら `<noscript>` で
   * 「JS が無いとできないこと」を伝える。
   *
   * **`loginHref` も要る。** 行き先を外枠が決め打つと、`/login` を
   * 配信しているのが別 Worker（auth-worker）であることが見えなくなる。
   */
  readonly hasRevokeActions?: boolean;
  /** 全端末からのログアウトができるログイン画面。`hasRevokeActions` のときに使う。 */
  readonly loginHref?: string;
  readonly children?: Child;
};

type SidebarProps = {
  readonly nav: readonly ShellNavGroup[];
  readonly current: ShellNavCurrent;
  readonly brandHref: string;
};

/** モバイルの折りたたみ用チェックボックスの id。`<label for>` と対にする。 */
const NAV_TOGGLE_ID = "kiwa-nav-toggle";

const Sidebar: FC<SidebarProps> = ({ nav, current, brandHref }) => (
  <nav class="flex flex-col px-3 py-5 md:py-8" aria-label="ダッシュボード">
    {/*
      **ホームに居るときはここが現在地である。** ホームは並びの項目では
      なくブランドのリンクなので、`aria-current` を付ける先もここになる。
      付けないと、ホームの画面だけサイドバー全体がどこも現在地でない
      状態になる。
      **モバイルでは隠す** —— 折りたたみを開いたときに出てくる地点が、
      常時見えているモバイルの上部バー（下記）と二重に出ないように。
    */}
    <a
      href={brandHref}
      class="mb-6 hidden px-3 text-xs font-medium tracking-[0.12em] text-foreground-soft uppercase transition-colors hover:text-foreground md:block"
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
  scripts = [],
  maxWidth = "max-w-3xl",
  hasRevokeActions = false,
  loginHref,
  children,
}) => (
  <Layout title={title} stylesheet={stylesheet} scripts={scripts}>
    <div class="flex min-h-dvh flex-col md:flex-row">
      {current !== undefined && [
        // **PC では無条件で表示する。** `sr-only` は見た目には出ない
        // だけで DOM からは消えない——フォーカス・Tab 移動・スクリーン
        // リーダーの両方が辿れる。
        <input key="nav-toggle" type="checkbox" id={NAV_TOGGLE_ID} class="peer sr-only" />,
        // **モバイルだけの上部バー。** 折りたたみが閉じていてもここだけは
        // 常に見えるので、ブランドへの行き先と開閉ボタンの両方をここに置く。
        <div
          key="mobile-bar"
          class="flex items-center justify-between border-b border-border px-5 py-4 md:hidden"
        >
          <a
            href={brandHref}
            class="text-xs font-medium tracking-[0.12em] text-foreground-soft uppercase transition-colors hover:text-foreground"
          >
            u18 Identity
          </a>
          <label
            for={NAV_TOGGLE_ID}
            class="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground-soft transition-colors hover:text-foreground"
          >
            メニュー
          </label>
        </div>,
        // **チェックボックスの直後の兄弟だけが `peer-checked:` を使える。**
        // `<nav>` 自身ではなくこの外側の `<div>` に掛けておけば、`Sidebar`
        // はモバイル専用の事情を一切知らずに済む。
        <div
          key="nav-wrapper"
          class="hidden flex-col border-b border-border peer-checked:flex md:flex md:w-64 md:border-r md:border-b-0"
        >
          <Sidebar nav={nav} current={current} brandHref={brandHref} />
        </div>,
      ]}
      <main class="min-w-0 flex-1 px-5 py-8 md:px-10 md:py-12">
        <div class={`mx-auto flex w-full ${maxWidth} flex-col gap-8`}>
          <div class="flex flex-col gap-2">
            <h1 class="text-2xl">{heading}</h1>
            {lead !== undefined && <p class="text-sm/relaxed text-foreground-muted">{lead}</p>}
          </div>
          {children}
          {hasRevokeActions && (
            <div class="flex flex-col gap-2">
              <noscript>
                <p class="text-sm/relaxed text-foreground-muted">
                  この画面での取り消し操作（ログアウト・削除・連携の解除）には JavaScript
                  が必要です。一覧の表示は JavaScript 無しでも行えます。
                </p>
                {loginHref !== undefined && (
                  <p class="text-sm/relaxed text-foreground-muted">
                    身に覚えのない端末がある場合は、
                    <a href={loginHref} class="text-foreground underline underline-offset-4">
                      ログイン画面
                    </a>
                    から「すべての端末からログアウト」を行えます。こちらは JavaScript
                    無しでも使えます。
                  </p>
                )}
              </noscript>
            </div>
          )}
        </div>
      </main>
    </div>
  </Layout>
);
