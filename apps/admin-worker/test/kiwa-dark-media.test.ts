import { env } from "cloudflare:test";
import { darkMediaVarNames } from "@u18/testing";
import { GDG_DARK_CLASS_VAR_NAMES } from "@u18/web-ui";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { KIWA_STYLESHEET_PATH } from "../src/presentation/http/ui/asset-paths";
import { executionContext, ORIGIN } from "./helpers";

/**
 * OS 設定（`prefers-color-scheme`）に従うライト/ダークが、**実際に配信
 * される CSS まで届いているか**（GDG デザイン移行 PR1、指摘: 3b）。
 *
 * `packages/web-ui/test/gdg-dark-media.test.ts` は `tokens.css` の `.dark`
 * と生成物（`generated/dark-media.css`）の変数名の集合が一致することを
 * 見ているが、それは**生成物の話**でしかない。`theme.css` の
 * `@import "../gdg/generated/dark-media.css"` を 1 行消しても、あちらの
 * テストは全部緑のまま通る——`@layer` の順序や Tailwind の
 * `optimize: true`（Lightning CSS）をくぐり抜けて、実際に配信される
 * バイト列に `@media (prefers-color-scheme: dark)` が残っているかは、
 * ここでしか見ていない。
 *
 * admin-worker には `kiwa-stylesheet.test.ts` が無い（`asset-coverage.
 * test.ts` が別の観点＝アセットとページの対応を見ている）。admin は 17
 * 画面を持つ主役で、auth/dashboard/nfc の 3 Worker だけにこの検査が
 * あるのは避けたい——同じ検査をここに置く。
 *
 * 「`prefers-color-scheme` という文字列が含まれる」だけでは弱い——ブロック
 * が残っていても中身が削られていたら気づけない。配信 CSS の @media が
 * 持つ変数名の集合を、vendored `tokens.css` の `.dark` が持つ集合
 * （`@u18/web-ui` の `GDG_DARK_CLASS_VAR_NAMES`、ビルド時に確定した配列）
 * と直接突き合わせる。
 *
 * `tokens.css` を直接 `readFileSync` しない——Worker のテストは
 * workerd の中で動き、素の `node:fs` でディスク上の任意のファイルを
 * 読めない（実測済み：`ENOENT` になる）。
 */
describe("配信する CSS に、OS 設定に従うダークの @media が実際に届いている", () => {
  it("@media (prefers-color-scheme: dark) の変数名の集合が tokens.css の .dark と一致する", async () => {
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${KIWA_STYLESHEET_PATH}`),
      env,
      executionContext(),
    );
    expect(response.status, `${KIWA_STYLESHEET_PATH} が ${response.status}`).toBe(200);
    const css = await response.text();

    const delivered = darkMediaVarNames(css);

    // 0 件のまま下の比較へ進むと、空集合同士の一致で緑になりうる。
    expect(
      delivered.size,
      "配信 CSS に @media (prefers-color-scheme: dark) が見つからない——" +
        "theme.css の @import が外れたか、ビルドの途中で落ちている可能性がある。",
    ).toBeGreaterThan(0);

    expect(GDG_DARK_CLASS_VAR_NAMES.length).toBeGreaterThan(0);

    expect([...delivered].sort()).toEqual([...GDG_DARK_CLASS_VAR_NAMES].sort());
  });
});
