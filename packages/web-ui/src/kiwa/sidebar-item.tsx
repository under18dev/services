/**
 * Kiwa UI の `registry/ui/sidebar-item.tsx` を取り込んだもの（#332、MIT）。
 *
 * **上流のまま置いている。** 変えたのは import の書き方だけで、
 * `@/lib/utils` -> `./utils` のように**このリポジトリの相対パス**へ
 * 直している。クラスの中身には手を入れていない。
 *
 * 由来と更新の仕方は `./README.md` を参照。
 */

import type { FC, JSX } from "hono/jsx";
import { cn } from "./utils";
import { Badge } from "./badge";

export const sidebarItemVariants = {
  base: "text-foreground-muted hover:bg-foreground/5 hover:text-foreground",
  active: "bg-foreground/5 text-foreground",
  size: {
    default: "h-8 px-3 gap-2",
    sm: "h-8 px-3 gap-2",
  },
};

type SidebarItemProps = JSX.IntrinsicElements["a"] & {
  size?: keyof typeof sidebarItemVariants.size;
  active?: boolean;
};

type SidebarItemButtonProps = JSX.IntrinsicElements["button"] & {
  size?: keyof typeof sidebarItemVariants.size;
  active?: boolean;
};

const getSidebarItemClasses = (
  size: keyof typeof sidebarItemVariants.size,
  active: boolean,
  className?: SidebarItemProps["class"] | SidebarItemButtonProps["class"],
) => {
  return cn(
    "flex items-center rounded-lg border border-transparent text-sm font-medium transition-colors outline-none",
    "[&_svg]:size-4 [&_svg]:shrink-0",
    "focus-visible:border-ring focus-visible:ring-ring/20 focus-visible:ring-[3px]",
    sidebarItemVariants.size[size],
    active ? sidebarItemVariants.active : sidebarItemVariants.base,
    className,
  );
};

export const SidebarItem: FC<SidebarItemProps> = ({
  size = "default",
  active = false,
  class: className,
  children,
  ...props
}) => (
  <a
    data-slot="sidebar-item"
    data-active={active ? "true" : undefined}
    class={getSidebarItemClasses(size, active, className)}
    {...props}
  >
    {children}
  </a>
);

export const SidebarItemButton: FC<SidebarItemButtonProps> = ({
  size = "default",
  active = false,
  class: className,
  type = "button",
  children,
  ...props
}) => (
  <button
    type={type}
    data-slot="sidebar-item-button"
    data-active={active ? "true" : undefined}
    class={getSidebarItemClasses(
      size,
      active,
      cn("w-full", className),
    )}
    {...props}
  >
    {children}
  </button>
);

type SidebarItemBadgeProps = JSX.IntrinsicElements["span"] & {
  children: string | number;
};

export const SidebarItemBadge: FC<SidebarItemBadgeProps> = ({
  children,
  class: className,
  ...props
}) => (
  <Badge variant="secondary" class={cn("ml-auto", className)} {...props}>
    {children}
  </Badge>
);
