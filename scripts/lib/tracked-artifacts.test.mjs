import assert from "node:assert/strict";
import { test } from "node:test";
import { findTrackedArtifacts, parseLsFiles } from "./tracked-artifacts.mjs";

const paths = (...list) => findTrackedArtifacts(list).map((f) => f.path);

test("#388 で入った形を拾う", () => {
  assert.deepEqual(
    paths(
      "scripts/__pycache__/nfc-burn.cpython-310.pyc",
      "scripts/__pycache__/nfc-spike.cpython-310.pyc",
      "scripts/nfc-spike.py",
    ),
    [
      "scripts/__pycache__/nfc-burn.cpython-310.pyc",
      "scripts/__pycache__/nfc-spike.cpython-310.pyc",
    ],
  );
});

test("拡張子だけでも拾う（__pycache__ の外に置かれた .pyc）", () => {
  assert.deepEqual(paths("scripts/nfc_ndef.pyc", "scripts/nfc_ndef.pyo"), [
    "scripts/nfc_ndef.pyc",
    "scripts/nfc_ndef.pyo",
  ]);
});

test("他の生成物も見る", () => {
  assert.deepEqual(
    paths(
      "packages/web-ui/dist/index.js",
      "apps/auth-worker/node_modules/x/index.js",
      "coverage/lcov.info",
      "apps/nfc-worker/.wrangler/state/v3/d1/db.sqlite",
      "packages/db/tsconfig.tsbuildinfo",
      "docs/.DS_Store",
      "deploy.log",
      "apps/auth-worker/src/presentation/http/ui/generated/login.js",
    ).length,
    8,
  );
});

test("手で書いたものは拾わない", () => {
  // **ここが一番大事。** 1 つでも誤検知する検査は、2 回目から飛ばされる。
  assert.deepEqual(
    paths(
      "scripts/nfc-burn.py",
      "scripts/lib/tracked-artifacts.mjs",
      "docs/u18-identity-spec.md",
      ".gitignore",
      "package.json",
      // ディレクトリ名の一部に当たらないこと。
      "docs/distribution/README.md",
      "packages/web-ui/src/distance.ts",
      "apps/auth-worker/src/presentation/http/ui/login.tsx",
      // `.log` は拡張子のときだけ。
      "docs/changelog.md",
      "packages/config/catalog.ts",
    ),
    [],
  );
});

test("見つけたものには、何として拾ったかが付く", () => {
  const [found] = findTrackedArtifacts(["scripts/__pycache__/nfc-burn.cpython-310.pyc"]);
  assert.equal(found.label, "__pycache__/");
  assert.match(found.hint, /#388/);
});

test("ls-files の出力は NUL で切る", () => {
  // 改行を含むファイル名を 2 つに割らないため `-z` で受ける。
  assert.deepEqual(parseLsFiles("a.md\0dir/b with\nnewline.md\0"), [
    "a.md",
    "dir/b with\nnewline.md",
  ]);
  assert.deepEqual(parseLsFiles(""), []);
});
