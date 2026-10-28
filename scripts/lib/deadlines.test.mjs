import assert from "node:assert/strict";
import { test } from "node:test";
import { findDeadlines, review } from "./deadlines.mjs";

/** ランブック §13.2 に実際に入っている形。 */
const REAL =
  "> **決める期限: 2026-11-30。** 条件（「必要になったら」）は誰も監視しないが、**日付なら機械が監視できる。**";

test("強調の中の期限を拾う", () => {
  const found = findDeadlines("docs/runbook.md", REAL);
  assert.equal(found.length, 1);
  assert.equal(found[0].date, "2026-11-30");
  assert.equal(found[0].line, 1);
  assert.equal(found[0].path, "docs/runbook.md");
});

test("地の文の日付は拾わない —— 過去の事実が混ざるため", () => {
  // deploy.yml と runbook に実在する形。これを拾うと毎日落ちる。
  const prose = "#106 は 2026-10-24 に閉じており、直近のデプロイはすべて success である。";
  assert.deepEqual(findDeadlines("docs/runbook.md", prose), []);
});

test("強調の中でも「期限」と書いていなければ拾わない", () => {
  const other = "**2026-10-24 に閉じた。**";
  assert.deepEqual(findDeadlines("docs/runbook.md", other), []);
});

test("1 つのファイルに複数あっても全部拾い、行番号を付ける", () => {
  const text = [
    "序文",
    "**決める期限: 2026-11-30。**",
    "間の行",
    "**移行期限: 2027-01-15。**",
  ].join("\n");
  const found = findDeadlines("docs/runbook.md", text);
  assert.deepEqual(
    found.map((d) => [d.line, d.date]),
    [
      [2, "2026-11-30"],
      [4, "2027-01-15"],
    ],
  );
});

test("同じ行に 2 つあっても両方拾う", () => {
  const text = "**期限: 2026-11-30。** と **期限: 2026-12-31。**";
  assert.equal(findDeadlines("docs/runbook.md", text).length, 2);
});

const DL = (date) => findDeadlines("f.md", `**決める期限: ${date}。**`)[0];

test("期限より前なら ok", () => {
  const result = review([DL("2026-11-30")], new Date("2026-11-29T23:59:59Z"));
  assert.equal(result.ok, true);
  assert.equal(result.passed.length, 0);
  assert.equal(result.upcoming.length, 1);
});

test("期限の当日は ok にしない —— その日までに決めるという意味なので", () => {
  const result = review([DL("2026-11-30")], new Date("2026-11-30T00:00:00Z"));
  assert.equal(result.ok, false);
  assert.equal(result.passed.length, 1);
});

test("期限を過ぎたら ok にしない", () => {
  const result = review([DL("2026-11-30")], new Date("2026-12-01T00:00:00Z"));
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.passed.map((d) => d.date),
    ["2026-11-30"],
  );
});

test("時刻は見ない —— 同じ日なら時刻によらず同じ答えになる", () => {
  const early = review([DL("2026-12-01")], new Date("2026-11-30T00:00:00Z"));
  const late = review([DL("2026-12-01")], new Date("2026-11-30T23:59:59Z"));
  assert.equal(early.ok, late.ok);
});

test("過ぎたものと来ていないものが混ざったら ok にしない", () => {
  const result = review([DL("2026-11-30"), DL("2027-06-01")], new Date("2026-12-01T00:00:00Z"));
  assert.equal(result.ok, false);
  assert.equal(result.passed.length, 1);
  assert.equal(result.upcoming.length, 1);
});

test("来ていないものは近い順に並べる", () => {
  const result = review(
    [DL("2027-06-01"), DL("2026-12-31"), DL("2027-01-15")],
    new Date("2026-11-01T00:00:00Z"),
  );
  assert.deepEqual(
    result.upcoming.map((d) => d.date),
    ["2026-12-31", "2027-01-15", "2027-06-01"],
  );
});

test("0 件は成功にしない —— 全部片付いたのか書き方が変わったのか区別できない", () => {
  const result = review([], new Date("2026-11-01T00:00:00Z"));
  assert.equal(result.ok, false);
  assert.equal(result.empty, true);
  assert.equal(result.passed.length, 0);
});

test("0 件と「過ぎたものがある」は別の報せ方ができる", () => {
  const empty = review([], new Date("2026-11-01T00:00:00Z"));
  const late = review([DL("2026-01-01")], new Date("2026-11-01T00:00:00Z"));
  assert.equal(empty.empty, true);
  assert.equal(late.empty, false);
  // どちらも ok は false だが、呼び出し側が文面を変えられる。
  assert.equal(empty.ok, late.ok);
});

test("報告に使う文面から強調の記号を落とす", () => {
  const found = findDeadlines("docs/runbook.md", REAL);
  assert.ok(!found[0].text.includes("*"));
  assert.match(found[0].text, /決める期限: 2026-11-30/);
});
