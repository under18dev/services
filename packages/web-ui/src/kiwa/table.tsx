/**
 * Kiwa UI の `registry/ui/table.tsx` を取り込んだもの（#375、MIT）。
 *
 * **上流のまま置いている。** 変えたのは import の書き方と、下の
 * selected 状態の背景色ユーティリティ（#534 で外した）だけ。
 *
 * ## selected 状態の背景色ユーティリティを外した（#534）
 *
 * 上流はテーブルライブラリ側（TanStack Table 相当）が行の選択状態に
 * 応じて `<tr data-state="selected">` を付け外す前提だが、**その属性を
 * セットするコードがこのリポジトリのどこにも無い**（各 Worker の
 * クライアント島を含めて確認済み）。一括操作（#481）はチェックボックスと
 * 件数表示（`attachSelection`、admin-worker の `client/admin-island.ts`）
 * で完結していて、行のハイライトは元から持っていない。
 *
 * `badge.tsx`（#338）とは原因が逆である。あちらは **class が HTML に
 * 出るのに CSS が無い** 事故、こちらは **CSS は正しく生成されるのに、
 * 発火させる属性を誰もセットしない**——どちらも「効いていない class」
 * だが、原因が逆なので同じ直し方（token を当て直す）はできない。
 *
 * **外した class 文字列をこのコメントにそのまま書かないこと。**
 * Tailwind の走査はソースの地の文もコメントも区別せず読むので、
 * 書いた瞬間に「生きた候補」として扱われ、消したはずの CSS が
 * 復活する——実際に一度これで見落とし、`build-client.mjs` を回して
 * 出力を実測するまで気づかなかった。
 *
 * 由来と判断の詳細は `./README.md` を参照。
 *
 * ## #341 が外していたものである
 *
 * `docs/kiwa-ui-migration.md` §3.3 が「`.facts` も `.list` も**0 件に
 * なりうる**。ヘッダ行だけが残る表になる」として外していた。
 * **あれは 3 つの対象についての判断で、表そのものを禁じてはいない。**
 *
 * **0 件のときの見せ方は呼ぶ側が決める。** 利用者の管理画面
 * （admin-worker の `users-page.tsx`。#433 で dashboard-worker の
 * `admin-users-page.tsx` から移った）は、**0 件なら表を描かず文だけ出す**
 * ——
 * ヘッダ行だけの表は「列はあるのに中身が無い」と読め、取得に失敗した
 * ようにも見える。
 *
 * ## インライン `style=` を出さない
 *
 * §3.4 が外した `progress` / `slider` と違い、このファイルは class しか
 * 出さない。CSP（`style-src 'self'`）で捨てられるものが無い。
 *
 * ## JS を要求しない
 *
 * `tabs` / `dialog` と違い、ただの `<table>` である。JS が落ちても読める。
 */

import type { FC, JSX } from "hono/jsx";
import { cn } from "./utils";

type TableProps = JSX.IntrinsicElements["table"];

export const Table: FC<TableProps> = ({
  class: className,
  children,
  ...props
}) => (
  <div data-slot="table-container" class="relative w-full overflow-x-auto">
    <table
      data-slot="table"
      class={cn("w-full caption-bottom text-sm", className)}
      {...props}
    >
      {children}
    </table>
  </div>
);

type TableHeaderProps = JSX.IntrinsicElements["thead"];

export const TableHeader: FC<TableHeaderProps> = ({
  class: className,
  children,
  ...props
}) => (
  <thead
    data-slot="table-header"
    class={cn("[&_tr]:border-b [&_tr]:border-border [&_tr]:hover:bg-transparent", className)}
    {...props}
  >
    {children}
  </thead>
);

type TableBodyProps = JSX.IntrinsicElements["tbody"];

export const TableBody: FC<TableBodyProps> = ({
  class: className,
  children,
  ...props
}) => (
  <tbody
    data-slot="table-body"
    class={cn("[&_tr:last-child]:border-0", className)}
    {...props}
  >
    {children}
  </tbody>
);

type TableFooterProps = JSX.IntrinsicElements["tfoot"];

export const TableFooter: FC<TableFooterProps> = ({
  class: className,
  children,
  ...props
}) => (
  <tfoot
    data-slot="table-footer"
    class={cn(
      "bg-muted border-t font-medium [&>tr]:last:border-b-0",
      className,
    )}
    {...props}
  >
    {children}
  </tfoot>
);

type TableRowProps = JSX.IntrinsicElements["tr"];

export const TableRow: FC<TableRowProps> = ({
  class: className,
  children,
  ...props
}) => (
  <tr
    data-slot="table-row"
    class={cn(
      "border-b border-border transition-colors",
      "hover:bg-muted/50",
      className,
    )}
    {...props}
  >
    {children}
  </tr>
);

type TableHeadProps = JSX.IntrinsicElements["th"];

export const TableHead: FC<TableHeadProps> = ({
  class: className,
  children,
  ...props
}) => (
  <th
    data-slot="table-head"
    class={cn(
      "h-10 px-2 text-left align-middle text-xs font-medium text-foreground-muted whitespace-nowrap",
      "[&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
      className,
    )}
    {...props}
  >
    {children}
  </th>
);

type TableCellProps = JSX.IntrinsicElements["td"];

export const TableCell: FC<TableCellProps> = ({
  class: className,
  children,
  ...props
}) => (
  <td
    data-slot="table-cell"
    class={cn(
      "p-2 align-middle whitespace-nowrap",
      "[&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
      className,
    )}
    {...props}
  >
    {children}
  </td>
);

type TableCaptionProps = JSX.IntrinsicElements["caption"];

export const TableCaption: FC<TableCaptionProps> = ({
  class: className,
  children,
  ...props
}) => (
  <caption
    data-slot="table-caption"
    class={cn("mt-4 text-sm text-foreground-muted", className)}
    {...props}
  >
    {children}
  </caption>
);
