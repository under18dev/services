import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * **島が読むファイルが何も import しないこと**（#332 / #338）。
 *
 * ## 何が起きたか
 *
 * nfc-worker が自分の `island-classes.ts` で `getButtonClasses()`
 * （Kiwa の button）を呼んだ。**島がそのファイルを import した瞬間に
 * `cn`（clsx + tailwind-merge）ごとバンドルへ入り、18.4 KiB の想定に
 * 対して 36.2 KiB になった**（services-66 の実測）。
 *
 * **ビルドは成功する。型検査も通る。テストも通る。** 言うのは
 * バンドルの大きさだけで、それを見る検査は無かった。
 *
 * ## なぜ大きさではなく import を見るのか
 *
 * 上限の数値を置く形も考えたが、**「何 KiB までなら良いか」は誰にも
 * 言えない。** 島は機能が増えれば大きくなるので、上限は上げ続けることに
 * なり、上げた瞬間に意味を失う。
 *
 * 守りたい規則は「**このファイルは何も import しない**」という 1 行で、
 * それはそのまま読める。`cn` が入るかどうかはその帰結にすぎない。
 *
 * ## `index.ts` からも再 export しない
 *
 * barrel（`./kiwa/index.ts`）は `card.tsx` / `button.tsx` を束ねている
 * ので、そこ経由で読むと同じことが起きる。島は
 * `@u18/web-ui/kiwa/island-classes` を**直接**指すこと。
 */

const ROOT = new URL("../../..", import.meta.url).pathname;

/** 島が import してよいファイル。**増やすときはこの検査の理由を読むこと。** */
const ISLAND_SAFE_FILES = [
  "packages/web-ui/src/kiwa/island-classes.ts",
  "apps/dashboard-worker/src/presentation/http/ui/island-classes.ts",
  "apps/dashboard-worker/src/presentation/http/ui/island-hooks.ts",
  "apps/nfc-worker/src/presentation/http/ui/island-classes.ts",
  "apps/nfc-worker/src/presentation/http/ui/island-hooks.ts",
];

describe("島が読むファイルは何も import しない", () => {
  it.each(ISLAND_SAFE_FILES)("%s", (file) => {
    const source = readFileSync(`${ROOT}${file}`, "utf8");

    // **コメントを落としてから見る。** 冒頭の JSDoc が `import` という
    // 語を含むので、素のままだと常に落ちる。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

    expect(
      [...code.matchAll(/^\s*(?:import|export)\s.*\bfrom\b.*$/gm)].map((m) => m[0].trim()),
      `${file} が他のモジュールを読んでいる。島がこれを import すると、` +
        `その依存ごとバンドルへ入る（cn で 18.4 -> 36.2 KiB になった）。`,
    ).toEqual([]);
  });

  it("一覧が空でない", () => {
    // 0 件だと上の `it.each` が 1 件も走らず、**何も確かめずに通る。**
    expect(ISLAND_SAFE_FILES.length).toBeGreaterThan(0);
  });

  it("共有の語彙は barrel から出ていない", () => {
    // 出ていると、島が `@u18/web-ui/kiwa` と書いた瞬間に card / button が
    // 付いてくる。**深いパスを指させる**ための規則。
    const barrel = readFileSync(`${ROOT}packages/web-ui/src/kiwa/index.ts`, "utf8");

    expect(barrel).not.toContain("island-classes");
  });
});
