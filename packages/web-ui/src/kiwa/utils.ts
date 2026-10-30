import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Kiwa UI のコンポーネントがクラス名を組み立てるのに使う（#332）。
 *
 * **`registry/lib/utils.ts` をそのまま取り込んだもの**（MIT）。
 * `getInitials` は使っていないので持ってきていない。
 *
 * ## 2 段になっているのはなぜか
 *
 * `clsx` は条件付きのクラス（`false && "..."` や配列）を 1 本の文字列に
 * 畳むだけで、**同じ性質を 2 回指定したときにどちらが勝つかは決めない。**
 * Tailwind では `px-6` と `px-4` のように**後ろが勝つとは限らない**
 * （出力 CSS での順序で決まる）ので、呼び出し側が `class="px-4"` を
 * 渡しても既定の `px-6` が残る。
 *
 * `twMerge` が「同じ性質の後ろ側だけを残す」。これが無いと、
 * **上書きしたつもりの指定が黙って効かない。**
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
