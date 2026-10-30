/**
 * Kiwa UI の `registry/ui/table.tsx` を取り込んだもの（#375、MIT）。
 *
 * **上流のまま置いている。** 変えたのは import の書き方だけで、
 * `@/lib/utils` -> `./utils` へ直している。クラスの中身には手を
 * 入れていない。
 *
 * ## #341 が外していたものである
 *
 * `docs/kiwa-ui-migration.md` §3.3 が「`.facts` も `.list` も**0 件に
 * なりうる**。ヘッダ行だけが残る表になる」として外していた。
 * **あれは 3 つの対象についての判断で、表そのものを禁じてはいない。**
 *
 * **0 件のときの見せ方は呼ぶ側が決める。** 利用者の管理画面
 * （`admin-users-page.tsx`）は、**0 件なら表を描かず文だけ出す** ——
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
 *
 * 由来と更新の仕方は `./README.md` を参照。
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
      "hover:bg-muted/50 data-[state=selected]:bg-background",
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
