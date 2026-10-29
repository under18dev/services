import assert from "node:assert/strict";
import { test } from "node:test";
import { findForwardIssueRefs } from "./issue-refs.mjs";

const numbers = (text) => findForwardIssueRefs("x.md", text).map((r) => r.number);

test("これからのこととして指しているものを拾う", () => {
  assert.deepEqual(numbers("洗い出しの基準は #286 で決める。"), [286]);
  assert.deepEqual(numbers("凍結アカウントの保持期間は未決で、#27 で扱う。"), [27]);
  assert.deepEqual(numbers("消す手段は #265 で実装する。"), [265]);
  assert.deepEqual(numbers("**#265 が入るまでの応対は、正確に伝えること。**"), [265]);
});

test("済んだこととして指しているものは拾わない", () => {
  // **ここが一番大事。** 閉じた issue を過去形で指すのは正しい書き方で、
  // 落とすと「履歴を書けない」ことになる。
  for (const done of [
    "消す手段は #265 で実装済み（#267 / #269 / #272）。",
    "**`oauth_tokens` は #273 で対象に入れた。**",
    "ロール表現は #83 で実装済み。",
    "#106 は 2026-10-24 に閉じた。",
    "適合性は #28 で確認した。",
  ]) {
    assert.deepEqual(numbers(done), [], done);
  }
});

test("引用の中は見ない（決定が下りた時点の記録）", () => {
  assert.deepEqual(numbers("> いま無いのはその手段で、**#265 で実装する。**"), []);
  assert.deepEqual(numbers(">> 入れ子の引用でも同じ。#265 で決める。"), []);
});

test("コードブロックの中は見ない", () => {
  const text = [
    "```sh",
    "# 265 で決める",
    'echo "#265 で扱う"',
    "```",
    "地の文は #286 で決める。",
  ].join("\n");
  assert.deepEqual(numbers(text), [286]);
});

test("行と本文を返す", () => {
  const refs = findForwardIssueRefs("docs/runbook.md", "一行目\n基準は #286 で決める。\n");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].line, 2);
  assert.equal(refs[0].path, "docs/runbook.md");
  assert.equal(refs[0].text, "#286 で決める");
});

test("1 行に 2 つあっても両方拾う", () => {
  assert.deepEqual(numbers("#27 で扱うが、起点は #286 で決める。"), [27, 286]);
});

test("離れすぎた動詞は拾わない（別の文に繋がってしまう）", () => {
  assert.deepEqual(numbers("#265 は閉じたので、まったく別の長い話をここに書いてから決める。"), []);
});
