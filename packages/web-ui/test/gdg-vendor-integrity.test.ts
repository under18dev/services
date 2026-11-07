import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * vendored `tokens.css` / `components.css` が無改変であることの固定検査
 * （GDG デザイン移行 PR1、指摘: services-2b 経由 services-3b）。
 *
 * この PR の中心的な主張は「gdg-jp/design-system から無改変で vendoring
 * した」こと（`src/gdg/README.md`）だが、それを保証していたのは README の
 * 文章だけだった——`.prettierignore` は整形からは守るが、誰かが手で 1 行
 * 編集しても検査は落ちない。#530（Google Sans のサブセット）が同じ形の
 * 問題に対して vendor 元・生成物の SHA-256 を固定する方式を採っているので、
 * ここでも同じ形にする。
 *
 * 値がずれたら、README.md の更新手順に従って取り直し、取得コミット・
 * 取得日と合わせてこの SHA-256 も更新すること。
 */

const ROOT = join(import.meta.dirname, "..");

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("vendored CSS の SHA-256（gdg-jp/design-system, e543157f4c94cf35a3269a51b0dfca3f0714f7d8）", () => {
  it("tokens.css が置き換わっていない", () => {
    const buffer = readFileSync(join(ROOT, "src/gdg/tokens.css"));
    expect(buffer.length).toBe(5894);
    expect(sha256(buffer)).toBe("dc47021accbb259a4ab65ddff2341fc56d165fd981c990fd3b6eee7361ee4883");
  });

  it("components.css が置き換わっていない", () => {
    const buffer = readFileSync(join(ROOT, "src/gdg/components.css"));
    expect(buffer.length).toBe(85503);
    expect(sha256(buffer)).toBe("e63fe372690bd2af13847de41b27999e4de7090e5c64dcef6834e26301f731ba");
  });
});
