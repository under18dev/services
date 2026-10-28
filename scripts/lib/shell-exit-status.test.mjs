import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  enablesErrExit,
  extractRunBlocks,
  findUnguardedAssignments,
} from "./shell-exit-status.mjs";

/**
 * **実際に踏んだ 3 件をそのまま置いてある。** 作り物の例だけで試すと、
 * 「この検査は何を拾うのか」が書いた人の想像の範囲に閉じる。
 */
describe("このリポジトリで実際に踏んだ形", () => {
  it("#230: Referrer-Policy の取り出し（grep が途中・pipefail で拾われる）", () => {
    const source = `set -euo pipefail
referrer_policy="$(tr -d '\\r' < "$head_file" \\
  | grep -i '^referrer-policy:' | head -1 \\
  | cut -d: -f2- | tr 'A-Z' 'a-z' | tr -d '[:space:]')"
if [ -z "$referrer_policy" ]; then echo "::error::no header"; fi`;

    const found = findUnguardedAssignments(source);

    assert.equal(found.length, 1);
    assert.equal(found[0].name, "referrer_policy");
    assert.equal(found[0].line, 2);
  });

  it("#227: csrf トークンの取り出し（grep が先頭・pipefail 不要で落ちる）", () => {
    const source = `set -euo pipefail
token="$(grep -o 'name="csrf_token" value="[^"]*"' "$body" | head -1 | sed 's/.*value="//')"
if [ -z "$token" ]; then echo "::error::no hidden input"; exit 1; fi`;

    const found = findUnguardedAssignments(source);

    assert.equal(found.length, 1);
    assert.equal(found[0].name, "token");
  });

  it("preflight: grep -c（**全部埋まった＝成功したときだけ**落ちた形）", () => {
    const source = `set -euo pipefail
count="$(grep -c 'REPLACE_WITH_' "$file")"
echo "remaining: $count"`;

    assert.equal(findUnguardedAssignments(source).length, 1);
  });
});

describe("直してある形は拾わない", () => {
  it("|| true が付いていれば通す", () => {
    const source = `set -e
token="$(grep -o 'x' "$f" | head -1 || true)"`;

    assert.deepEqual(findUnguardedAssignments(source), []);
  });

  it("|| : も通す", () => {
    assert.deepEqual(findUnguardedAssignments(`v="$(grep x f || :)"`), []);
  });

  it("if の条件に置いた形は拾わない（終了コードを if が食べる）", () => {
    // **これは直し方の 1 つである。** 拾ってしまうと、正しく直した人に
    // 「まだ直っていない」と言うことになる。
    const source = `set -e
if v="$(grep x f)"; then echo "$v"; fi`;

    assert.deepEqual(findUnguardedAssignments(source), []);
  });

  it("grep を含まない代入は拾わない", () => {
    assert.deepEqual(findUnguardedAssignments(`v="$(date +%s)"`), []);
  });

  it("コマンド置換でない代入は拾わない", () => {
    assert.deepEqual(findUnguardedAssignments(`grep_count=0`), []);
  });

  it("コメントの中の例は拾わない", () => {
    // ドキュメントに「こう書くと落ちる」と例示する余地を残す。
    assert.deepEqual(findUnguardedAssignments(`# v="$(grep x f)"`), []);
  });
});

describe("set -e を使っていないスクリプト", () => {
  it("set -e があれば true", () => {
    assert.equal(enablesErrExit("#!/bin/sh\nset -euo pipefail\n"), true);
    assert.equal(enablesErrExit("set -e\n"), true);
  });

  it("無ければ false", () => {
    // **この場合この形は危なくない。** 拾うと「直す必要のないもの」を
    // 直させることになり、検査そのものが信用されなくなる。
    assert.equal(enablesErrExit("#!/bin/bash\necho hi\n"), false);
  });
});

describe("ワークフローの run: ブロックだけを見る", () => {
  const yaml = `jobs:
  a:
    steps:
      - name: Check
        run: |
          v="$(grep x f)"
          echo "$v"
      - name: Other
        uses: actions/checkout@v4
      - run: |
          w="$(grep y g || true)"
`;

  it("run: の中だけを、元の行番号つきで返す", () => {
    const blocks = extractRunBlocks(yaml);

    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].startLine, 6);
    assert.ok(blocks[0].text.includes(`v="$(grep x f)"`));
    // run: の外（uses: の行）は入らない。
    assert.ok(!blocks.some((b) => b.text.includes("uses:")));
  });

  it("守られていないほうだけを、正しい行番号で出す", () => {
    const found = extractRunBlocks(yaml).flatMap(({ startLine, text }) =>
      findUnguardedAssignments(text).map((f) => ({ ...f, line: startLine + f.line - 1 })),
    );

    assert.equal(found.length, 1);
    assert.equal(found[0].name, "v");
    assert.equal(found[0].line, 6);
  });

  it("`|| true` が**継続行**にあっても守られていると見る", () => {
    /**
     * **この検査の最初の実行で踏んだ誤検知そのもの。**
     *
     * `ci.yml` の codeql-action の照合は `\` で 2 行に分かれていて、
     * `|| true` は 2 行目にある。ブロックを行ごとに切って渡していたので、
     * **既に直してあるものを「直っていない」と言った。**
     *
     * 直した人に嘘をつく検査は、2 回目から読まれなくなる。
     */
    const withContinuation = `jobs:
  a:
    steps:
      - run: |
          refs="$(grep -ho 'pattern' \\
            .github/workflows/*.yml 2>/dev/null || true)"
          echo "$refs"
`;

    const found = extractRunBlocks(withContinuation).flatMap(({ text }) =>
      findUnguardedAssignments(text),
    );

    assert.deepEqual(found, []);
  });
});
