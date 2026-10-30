import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  getButtonClasses,
} from "@u18/web-ui/kiwa";
import { classesIn } from "@u18/testing";
import type { Child } from "hono/jsx";
import { describe, expect, it } from "vitest";
import {
  BUTTON_CLASS,
  DANGER_BUTTON_CLASS,
  PANEL_BODY_CLASS,
  PANEL_CLASS,
  PANEL_DESC_CLASS,
  PANEL_HEADER_CLASS,
  PANEL_TITLE_CLASS,
} from "../src/presentation/http/ui/island-classes";

/**
 * アイランドのボタンが Kiwa のボタンと同じ見た目か（#332）。
 *
 * ## なぜ写しているのか
 *
 * `getButtonClasses()` は `cn()`（clsx + tailwind-merge）を呼ぶ。
 * **島へ持ち込むと 27.8 KB** で、島そのもの（18.4 KiB）より大きい。
 * 取り消しができるようになる代わりに読み込みが 2 倍になるのは釣り合わない。
 *
 * そこで `island-classes.ts` にはリテラルを置き、**同じ値であることを
 * ここで確かめる。** 写し間違いも、上流が変わったときも、ここで落ちる。
 *
 * ## 文字列をそのまま比べない
 *
 * `cn()` は `tailwind-merge` を通すので、**並び順が変わりうる。**
 * 順序は CSS の効き方に関係しない（出力 CSS 側の順序で決まる）ので、
 * **集合として比べる。**
 */

const asSet = (classes: string): ReadonlySet<string> =>
  new Set(classes.split(/\s+/).filter(Boolean));

describe("島のボタンのクラス", () => {
  it("ふつうのボタンが Kiwa の outline / sm と同じ", () => {
    expect(asSet(BUTTON_CLASS)).toEqual(asSet(getButtonClasses("outline", "sm")));
  });

  it("取り消しのボタンは、それに文字色だけ足したもの", () => {
    // **面を赤く塗らない**（一覧の各行に並ぶので design.md の
    // "No colorful UI." に当たる）。足すのは文字色だけであることを固定する。
    const added = [...asSet(DANGER_BUTTON_CLASS)].filter(
      (name) => !asSet(getButtonClasses("outline", "sm")).has(name),
    );

    expect(added.sort()).toEqual(["hover:text-destructive", "text-destructive"]);
  });
});

describe("島が手で組むパネルが Kiwa の Card と同じ", () => {
  /**
   * プロフィールの編集パネルは**島が囲いごと作る**（`profile-page.tsx`）。
   * サーバーが `<Card>` で描く他のパネルと**見た目が違うと、同じ画面の
   * 中で枠が 2 種類**になる。落ちないし、並べて見るまで分からない。
   *
   * **実際に描いて `class` を抜く。** Kiwa 側が変われば落ちる。
   */
  const classOf = async (node: Child): Promise<ReadonlySet<string>> => {
    const html = await (node as { toString(): Promise<string> }).toString();
    // **`classesIn` を使う。** hono/jsx は `&` を `&amp;` にするので、
    // 属性値をそのまま比べると `[&_[data-slot=...]]` が一致しない
    // （同じ取り違えを一度やっている。あちらの冒頭を参照）。
    return new Set(classesIn(html));
  };

  it.each([
    ["Card", PANEL_CLASS, <Card />],
    ["CardHeader", PANEL_HEADER_CLASS, <CardHeader />],
    ["CardTitle", PANEL_TITLE_CLASS, <CardTitle />],
    ["CardDescription", PANEL_DESC_CLASS, <CardDescription />],
    ["CardContent", PANEL_BODY_CLASS, <CardContent />],
  ] as const)("%s", async (_name, constant, node) => {
    expect(asSet(constant)).toEqual(await classOf(node));
  });
});
