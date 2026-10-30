/**
 * Kiwa UI の `registry/ui/badge.tsx` を取り込んだもの（#332、MIT）。
 *
 * **上流のまま置いている。** 変えたのは import の書き方と、
 * 下の `border-subtle` の 1 語だけ。
 *
 * ## `secondary` の枠線は上流では出ない（#338）
 *
 * 上流は `border border-subtle` と書いているが、**`border-subtle` は
 * Tailwind のユーティリティとして存在しない。** トークンは
 * `--color-border-subtle` で、そこから作られる class は
 * `border-border-subtle` である（`--color-subtle` は上流の
 * `globals.css` にも無い）。
 *
 * つまり上流のままだと **class は HTML に出るのに CSS が無い** ——
 * #320 とまったく同じ形で、`variant="secondary"` のバッジだけ枠線が
 * 消える。落ちも警告も出ない。
 *
 * `test/kiwa-stylesheet.test.ts`（nfc）が実際にこれで落ちた。
 * **取り込んだ 6 つを端から端まで調べて、効いていない class はこの
 * 1 つだけだった**（207 個の class 文字列を検査した）。
 *
 * 由来と更新の仕方、手を入れた箇所の一覧は `./README.md` を参照。
 */

import type { FC, JSX } from "hono/jsx";
import { cn } from "./utils";

const badgeVariants = {
  variant: {
    default:
      "border border-primary/20 bg-primary-soft text-primary [a&]:hover:bg-primary-soft/80",
    secondary:
      "border border-border-subtle bg-secondary text-secondary-foreground [a&]:hover:bg-secondary-hover",
    destructive:
      "border border-destructive/20 bg-destructive-soft text-destructive [a&]:hover:bg-destructive-soft/80",
    success:
      "border border-success/20 bg-success-soft text-success [a&]:hover:bg-success-soft/80",
    warning:
      "border border-warning/20 bg-warning-soft text-warning-foreground [a&]:hover:bg-warning-soft/80",
    outline:
      "border border-border bg-background-raised text-foreground [a&]:hover:bg-background-subtle [a&]:hover:text-foreground",
    "outline-primary": "border border-border text-primary",
    "outline-destructive": "border border-border text-destructive",
    "outline-success": "border border-border text-success",
    "outline-warning": "border border-border text-warning",
    "outline-info": "border border-border text-info",
  },
};

type BadgeProps = JSX.IntrinsicElements["span"] & {
  variant?: keyof typeof badgeVariants.variant;
};

export const Badge: FC<BadgeProps> = ({
  variant = "default",
  class: className,
  children,
  ...props
}) => (
  <span
    data-slot="badge"
    class={cn(
      "inline-flex items-center justify-center rounded-md px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0",
      "[&>svg]:size-3 gap-1 [&>svg]:pointer-events-none",
      "focus-visible:border-ring focus-visible:ring-ring/20 focus-visible:ring-[3px]",
      "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
      "transition-[color,box-shadow] overflow-hidden",
      badgeVariants.variant[variant],
      className,
    )}
    {...props}
  >
    {children}
  </span>
);
