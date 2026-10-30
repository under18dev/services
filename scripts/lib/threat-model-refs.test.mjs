import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { findReferences, parseDefinedIds, SCAN_GLOBS } from "./threat-model-refs.mjs";

describe("parseDefinedIds", () => {
  it("見出しで定義された単独の脅威を拾う", () => {
    const source = "#### T-1：Redirect URI の操作\n\n本文\n\n#### N-5：手当ての外\n";

    const defined = parseDefinedIds(source);

    assert.ok(defined.has("T-1"));
    assert.ok(defined.has("N-5"));
  });

  it("半角コロンでも全角コロンでも拾う", () => {
    const source = "#### T-1: 半角\n#### T-2：全角\n";

    const defined = parseDefinedIds(source);

    assert.ok(defined.has("T-1"));
    assert.ok(defined.has("T-2"));
  });

  it("表の 1 列目で定義された RR を拾う", () => {
    const source = "| RR-1 | 解消済み | 低 |\n| RR-21 | 受容 | 中 |\n";

    const defined = parseDefinedIds(source);

    assert.ok(defined.has("RR-1"));
    assert.ok(defined.has("RR-21"));
  });

  it("RR-19 を R-19 として拾わない", () => {
    // 複合リスクの導出が R（否認）を先頭に持つ接頭辞と文字を共有する
    // ので、2 文字の接頭辞を 1 文字に読み違えないことを固定する。
    const source = "| RR-19 | 一部実装済み | 中 |\n";

    const defined = parseDefinedIds(source);

    assert.ok(defined.has("RR-19"));
    assert.ok(!defined.has("R-19"));
  });

  it("補足見出し（RR-19 の補足）を新しい定義として拾わない", () => {
    // `#### RR-19 の補足` は RR-19 を指す地の文であって、新しい ID の
    // 定義ではない。見出しパターンは単独接頭辞しか見ないので混ざらない。
    const source = "#### RR-19 の補足 —— 実測\n";

    const defined = parseDefinedIds(source);

    assert.equal(defined.size, 0);
  });

  it("本文中に番号が出てきても、見出し・表の 1 列目でなければ拾わない", () => {
    const source = "この段落は T-1 と RR-21 に触れているだけで、定義ではない。\n";

    const defined = parseDefinedIds(source);

    assert.equal(defined.size, 0);
  });
});

describe("findReferences", () => {
  it("単独接頭辞と RR の両方を拾う", () => {
    const source = "// T-1 と N-5、RR-21 を見ること\n";

    const refs = findReferences("src/example.ts", source);

    assert.deepEqual(
      refs.map((r) => r.id),
      ["T-1", "N-5", "RR-21"],
    );
  });

  it("行番号を 1 始まりで返す", () => {
    const source = "1 行目\nRR-5 はここ\n3 行目\n";

    const refs = findReferences("x.md", source);

    assert.equal(refs.length, 1);
    assert.equal(refs[0].line, 2);
  });

  it("RR-19 を R-19 と二重に拾わない", () => {
    const source = "RR-19 の補足を参照。\n";

    const refs = findReferences("x.md", source);

    assert.deepEqual(
      refs.map((r) => r.id),
      ["RR-19"],
    );
  });

  it("単語境界の無い一致は拾わない（ISO-8859-1 のようなもの）", () => {
    const source = "ISO-8859-1 や UTF-8 は脅威モデルの ID ではない。\n";

    const refs = findReferences("x.md", source);

    assert.equal(refs.length, 0);
  });
});

/**
 * 実物の `docs/threat-model.md` に対して、拾い方そのものが壊れていないことを
 * 固定する（`check-app-catalog-routes.mjs` の「実物のリポジトリで通る」と
 * 同じ考え方）。**ここでは「実在するか」までは見ない** —— それは
 * `scripts/check-threat-model-refs.mjs` の仕事で、CI でしか意味を持たない
 * （リポジトリの現在の状態次第で落ちうる検査を、単体テストに混ぜない）。
 */
describe("実物の docs/threat-model.md", () => {
  it("1 件以上の ID を定義として読める", () => {
    const source = readFileSync(new URL("../../docs/threat-model.md", import.meta.url), "utf8");

    const defined = parseDefinedIds(source);

    assert.ok(defined.size > 10, "見出しの書き方を変えたなら、このパターンも直すこと");
    assert.ok(defined.has("T-1"));
    assert.ok(defined.has("RR-1"));
  });
});

/**
 * `SCAN_GLOBS` が実際に対象を拾えているかを、作り物の glob パターンではなく
 * **実物のディレクトリに対して**確かめる（#371 のレビューで指摘された
 * `packages/*\/test` の抜けと同じ形の穴を、次に開く前に閉じる）。
 *
 * **各ルートに最低 1 ファイルあることを期待値にしている。** ゼロ件は
 * 「対象ディレクトリが無くなった」と「glob が拾えていない」を区別できない
 * ので、`apps/*\/src` のような実在が保証された場所だけを選んでいる。
 */
describe("SCAN_GLOBS が実物のディレクトリを拾う", () => {
  const roots = [
    "apps/*/src/**/*.ts",
    "apps/*/test/**/*.ts",
    "packages/*/src/**/*.ts",
    "packages/*/test/**/*.ts",
    "scripts/**/*.mjs",
  ];

  for (const root of roots) {
    it(`${root} に少なくとも 1 ファイルある`, () => {
      assert.ok(
        globSync(root).length > 0,
        `${root} が 0 件。ディレクトリ構成が変わったなら SCAN_GLOBS も見直すこと`,
      );
    });
  }

  it("SCAN_GLOBS 自身が apps と packages の両方の test を含む", () => {
    // **ここが #371 のレビューで実際に抜けていた行。** 文字列として
    // 「含まれているか」まで固定する——glob の数を数えるだけだと、
    // 似た別のパターンに差し替えられても検出できない。
    assert.ok(SCAN_GLOBS.includes("apps/*/test/**/*.{ts,tsx}"));
    assert.ok(SCAN_GLOBS.includes("packages/*/test/**/*.ts"));
  });
});
