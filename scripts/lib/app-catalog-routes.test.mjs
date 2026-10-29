import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  patternCovers,
  readCatalogUrls,
  readInventoryPaths,
  readStringConstants,
  resolveOwner,
  unreachablePaths,
} from "./app-catalog-routes.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const UI = path.join(ROOT, "apps", "dashboard-worker", "src", "presentation", "http", "ui");

/**
 * **実物を読めることを最初に確かめる。** この検査は TypeScript を
 * テキストとして読んでいるので、書き方が変わると黙って 0 件になる。
 * 合成した入力だけで試すと、そこが一番見えない。
 */
test("実物の APP_CATALOG を読める", () => {
  const urls = readCatalogUrls(readFileSync(path.join(UI, "app-catalog.ts"), "utf8"));

  assert.notEqual(urls, null, "APP_CATALOG を読み出せなかった");
  // いま載っているのは NFC の 1 件（定数参照）。増減したらここで気づく。
  assert.deepEqual(urls, ["@NFC_CARDS_PATH"]);
});

test("実物の asset-paths.ts から定数を解決できる", () => {
  const constants = readStringConstants(readFileSync(path.join(UI, "asset-paths.ts"), "utf8"));

  assert.equal(constants.NFC_CARDS_PATH, "/account/nfc");
  // テンプレートリテラルで組んだものは拾わない（この Worker 自身の画面）。
  assert.equal(constants.APPS_PATH, undefined);
});

test("空のカタログは 0 件として読める（読めなかったのとは別）", () => {
  assert.deepEqual(readCatalogUrls("export const APP_CATALOG: readonly X[] = [\n];"), []);
});

test("書き方が変わって拾えなくなったら null を返す", () => {
  // **ここが一番まずい失敗である。** 0 件として通すと、本番だけが 404 を出す。
  assert.equal(readCatalogUrls("const APP_CATALOG = buildFrom(db);"), null);
});

test("url を拾い漏らしたら null を返す（部分的に通さない）", () => {
  // `id` が 2 つあるのに `url` が 1 つしか取れない形。片方だけ拾って
  // 「検査対象 1 件」で通すと、拾い漏れた行が静かに抜ける。
  const text = [
    "export const APP_CATALOG: readonly X[] = [",
    '  { id: "a", url: "/a" },',
    '  { id: "b", url: `/${b}` },',
    "];",
  ].join("\n");

  assert.equal(readCatalogUrls(text), null);
});

test("リテラルの url と定数参照の両方を拾う", () => {
  const text = [
    "export const APP_CATALOG: readonly X[] = [",
    '  {\n    id: "a",\n    url: "/account/nfc",\n  },',
    '  {\n    id: "b",\n    url: SOMETHING_PATH,\n  },',
    "];",
  ].join("\n");

  assert.deepEqual(readCatalogUrls(text), ["/account/nfc", "@SOMETHING_PATH"]);
});

test("patternCovers: 裸の pattern は完全一致だけ", () => {
  assert.equal(patternCovers("auth.under18.dev/account/nfc", "/account/nfc"), true);
  assert.equal(patternCovers("auth.under18.dev/account/nfc", "/account/nfcx"), false);
  assert.equal(patternCovers("auth.under18.dev/account/nfc", "/account/nfc/cards"), false);
});

test("patternCovers: /* は接頭辞を覆う（裸の接頭辞も含む）", () => {
  // Cloudflare の `/*` は裸の接頭辞に当たらないが、**そこは
  // check-route-patterns.mjs の持ち場**である。こちらは「届くか」だけを
  // 見るので、両方を書くという向こうの規約の上で判定してよい。
  assert.equal(patternCovers("auth.under18.dev/account/nfc/*", "/account/nfc"), true);
  assert.equal(patternCovers("auth.under18.dev/account/nfc/*", "/account/nfc/cards"), true);
  assert.equal(patternCovers("auth.under18.dev/account/nfc/*", "/account/nfcx"), false);
});

test("patternCovers: ホスト全体は何でも覆う", () => {
  assert.equal(patternCovers("go.under18.dev/*", "/account/nfc"), true);
});

test("patternCovers: ホストは見ない（同じパスを別ホストが持ってよい）", () => {
  // カタログの url はパスだけで、どのホストで開くかは利用者のいる
  // オリジンが決める。
  assert.equal(patternCovers("example.invalid/account/nfc", "/account/nfc"), true);
});

test("patternCovers: パスを持たない pattern は覆わない", () => {
  assert.equal(patternCovers("go.under18.dev", "/account/nfc"), false);
});

/**
 * いま実在する形。dashboard の `/account/*` が同じパスに一致するので、
 * **「どれかが覆っている」だけ見ると nfc が動いても気づけない。**
 * 最初に書いた検査がこれで素通りした。
 */
const REAL_ROUTES = [
  { worker: "dashboard-worker", pattern: "auth.under18.dev/account" },
  { worker: "dashboard-worker", pattern: "auth.under18.dev/account/*" },
  { worker: "nfc-worker", pattern: "auth.under18.dev/account/nfc" },
  { worker: "nfc-worker", pattern: "auth.under18.dev/account/nfc/*" },
  { worker: "nfc-worker", pattern: "go.under18.dev/*" },
];

test("resolveOwner: 最長の pattern が勝つ", () => {
  // dashboard の `/account/*` にも一致するが、nfc のほうが長い。
  assert.deepEqual(resolveOwner(REAL_ROUTES, "/account/nfc"), {
    worker: "nfc-worker",
    pattern: "auth.under18.dev/account/nfc/*",
  });
});

test("resolveOwner: nfc が route を動かすと dashboard へ落ちる", () => {
  const moved = REAL_ROUTES.filter((r) => !r.pattern.includes("/account/nfc"));

  assert.deepEqual(resolveOwner(moved, "/account/nfc"), {
    worker: "dashboard-worker",
    pattern: "auth.under18.dev/account/*",
  });
});

test("resolveOwner: 覆う route が無ければ null", () => {
  assert.equal(resolveOwner([], "/account/nfc"), null);
});

test("resolveOwner: 同じ長さで Worker が割れたら決めない", () => {
  // **推測して通すと、外れたときに検査が「問題なし」と言う。**
  const tied = [
    { worker: "a-worker", pattern: "x.under18.dev/account/nfc" },
    { worker: "b-worker", pattern: "y.under18.dev/account/nfc" },
  ];

  assert.deepEqual(resolveOwner(tied, "/account/nfc"), { ambiguous: ["a-worker", "b-worker"] });
});

test("readInventoryPaths: path を拾う", () => {
  const text = [
    "export const PAGE_ROUTES = [",
    '  { method: "GET", path: "/account/nfc" },',
    '  { method: "GET", path: "/account/nfc/ui/u18.<hash>.css" },',
    "] as const;",
  ].join("\n");

  assert.deepEqual(readInventoryPaths(text), ["/account/nfc", "/account/nfc/ui/u18.<hash>.css"]);
});

test("unreachablePaths: 勝った Worker が登録していれば通る", () => {
  const problems = unreachablePaths(["/account/nfc"], REAL_ROUTES, () => ["/account/nfc"]);

  assert.deepEqual(problems, []);
});

test("unreachablePaths: 勝った Worker が登録していなければ落ちる", () => {
  // **これが守りたかった形である。** route は届くが Worker に登録が無い。
  const problems = unreachablePaths(["/account/nfc"], REAL_ROUTES, () => ["/account/other"]);

  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /nfc-worker does not register it/);
});

test("unreachablePaths: nfc が route を動かすと落ちる（素通りした形）", () => {
  const moved = REAL_ROUTES.filter((r) => !r.pattern.includes("/account/nfc"));
  // dashboard-worker は `/account/nfc` を登録していない。
  const problems = unreachablePaths(["/account/nfc"], moved, () => ["/account", "/account/apps"]);

  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /dashboard-worker does not register it/);
});

test("unreachablePaths: 覆う route が無ければ落ちる", () => {
  const problems = unreachablePaths(["/account/nfc"], [], () => []);

  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /no production route covers it/);
});

test("unreachablePaths: 一覧を読めなかったら「登録が無い」と言わない", () => {
  // 原因を取り違えさせない。一覧の書き方が変わった可能性がある。
  const problems = unreachablePaths(["/account/nfc"], REAL_ROUTES, () => null);

  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /could not be read/);
});

test("unreachablePaths: 決められない勝者は落とす", () => {
  const tied = [
    { worker: "a-worker", pattern: "x.under18.dev/account/nfc" },
    { worker: "b-worker", pattern: "y.under18.dev/account/nfc" },
  ];
  const problems = unreachablePaths(["/account/nfc"], tied, () => ["/account/nfc"]);

  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /not decidable/);
});
