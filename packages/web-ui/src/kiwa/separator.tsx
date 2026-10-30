/**
 * Kiwa UI の `registry/ui/separator.tsx` を取り込んだもの（#332、MIT）。
 *
 * **上流のまま置いている。** 変えたのは import の書き方だけで、
 * `@/lib/utils` -> `./utils` のように**このリポジトリの相対パス**へ
 * 直している。クラスの中身には手を入れていない。
 *
 * 由来と更新の仕方は `./README.md` を参照。
 */

import type { FC, JSX } from 'hono/jsx'
import { cn } from "./utils"

type SeparatorProps = JSX.IntrinsicElements['div'] & {
  orientation?: 'horizontal' | 'vertical'
  decorative?: boolean
}

export const Separator: FC<SeparatorProps> = ({
  orientation = 'horizontal',
  decorative = true,
  class: className,
  ...props
}) => (
  <div
    data-slot="separator"
    role={decorative ? 'none' : 'separator'}
    aria-orientation={decorative ? undefined : orientation}
    data-orientation={orientation}
    class={cn(
      'bg-border shrink-0',
      orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
      className
    )}
    {...props}
  />
)
