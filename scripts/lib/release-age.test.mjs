import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findStaleExclusions, parseReleaseAgePolicy } from "./release-age.mjs";

/**
 * `minimumReleaseAge` が設定されていること（#101）。
 *
 * **ここが落ちても誰も困らない、と思ったら読み違えである。** この設定が
 * 無い状態は、**インストールが通り CI も緑**で、除外リストだけが残る。
 * 「release age の対策は入れてある」と読めるのに何も効いていない。
 * 実際にそうなっていたのを見つけて、この検査を置いた。
 */

const WORKSPACE = readFileSync(new URL("../../pnpm-workspace.yaml", import.meta.url), "utf8");
const LOCKFILE = readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8");

test("minimumReleaseAge が設定されている", () => {
  const { minimumReleaseAge } = parseReleaseAgePolicy(WORKSPACE);

  assert.notEqual(
    minimumReleaseAge,
    null,
    "pnpm-workspace.yaml に minimumReleaseAge がありません。" +
      " 除外リストだけがある状態では、公開直後の版がそのまま入ります（#101）。",
  );
  assert.ok(
    (minimumReleaseAge ?? 0) > 0,
    `minimumReleaseAge が ${minimumReleaseAge} です。0 は「待たない」と同じです。`,
  );
});

test("除外に書かれた名前がツリーにある", () => {
  // **死んだ除外を溜めない。** 依存を消したのに除外を残すと、次に同じ
  // 名前のパッケージが入ったとき黙って守りが外れる。
  const { exclude } = parseReleaseAgePolicy(WORKSPACE);
  const stale = findStaleExclusions(exclude, LOCKFILE);

  assert.deepEqual(
    stale,
    [],
    `除外に書かれているがツリーに無い: ${stale.join(", ")}。` +
      " 使っていない除外は消してください。",
  );
});

test("parseReleaseAgePolicy: 値を読む", () => {
  const policy = parseReleaseAgePolicy(`packages:
  - "apps/*"

minimumReleaseAge: 10080
minimumReleaseAgeExclude:
  - "wrangler"
  - "@cloudflare/workers-types@5.1.0"
`);

  assert.equal(policy.minimumReleaseAge, 10080);
  assert.deepEqual(policy.exclude, ["wrangler", "@cloudflare/workers-types@5.1.0"]);
});

test("parseReleaseAgePolicy: 設定が無ければ null", () => {
  // **これが #101 で実際にあった状態。** 除外だけがある。
  const policy = parseReleaseAgePolicy(`minimumReleaseAgeExclude:
  - "@cloudflare/workers-types@5.20261023.1"
`);

  assert.equal(policy.minimumReleaseAge, null);
  assert.deepEqual(policy.exclude, ["@cloudflare/workers-types@5.20261023.1"]);
});

test("parseReleaseAgePolicy: 行コメントを読み飛ばす", () => {
  const policy = parseReleaseAgePolicy(`minimumReleaseAge: 4320 # 3 日
minimumReleaseAgeExclude:
  - "wrangler" # 高頻度リリース
`);

  assert.equal(policy.minimumReleaseAge, 4320);
  assert.deepEqual(policy.exclude, ["wrangler"]);
});

test("parseReleaseAgePolicy: リストの後ろの設定を巻き込まない", () => {
  const policy = parseReleaseAgePolicy(`minimumReleaseAgeExclude:
  - "wrangler"

strictPeerDependencies: false
`);

  assert.deepEqual(policy.exclude, ["wrangler"]);
});

test("findStaleExclusions: 無い名前を返す", () => {
  const lockfile = "  wrangler@4.152.0:\n  hono@4.13.13:\n";

  assert.deepEqual(findStaleExclusions(["wrangler", "hono"], lockfile), []);
  assert.deepEqual(findStaleExclusions(["left-pad"], lockfile), ["left-pad"]);
});

test("findStaleExclusions: スコープ付きの名前を正しく切る", () => {
  // `@scope/name@version` の `@` を素朴に切ると `@scope` になる。
  const lockfile = "  '@cloudflare/workers-types@5.20261023.1':\n";

  assert.deepEqual(findStaleExclusions(["@cloudflare/workers-types"], lockfile), []);
  assert.deepEqual(findStaleExclusions(["@cloudflare/workers-types@5.1.0"], lockfile), []);
  assert.deepEqual(findStaleExclusions(["@cloudflare/nope"], lockfile), ["@cloudflare/nope"]);
});
