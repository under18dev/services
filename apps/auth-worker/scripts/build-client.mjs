// @ts-check
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build } from "esbuild";

/**
 * クライアントアイランド（hono/jsx/dom）をブラウザ向けにバンドルする。
 *
 * ## なぜ Workers Assets ではなく「文字列として Worker に埋め込む」のか
 *
 * Workers Assets（wrangler.jsonc の `assets`）を使うと、静的ファイルが
 * Worker より先にリクエストを拾う経路が増える。ログイン画面のためだけに
 * ルーティングの優先順位を 1 段増やしたくない。また `pnpm test` は
 * workerd 上の vitest で走るので、アセットサーバーの挙動まで含めて
 * 同じように再現できるとは限らない。
 *
 * バンドル結果を TypeScript の文字列定数として吐けば、dev / test / build の
 * どれでも「ただのモジュール」として同じように解決される。
 * 配信は通常の Hono ルート（ui/assets.routes.ts）で行う。
 *
 * ## なぜ生成物をコミットしないのか
 *
 * 出力は .gitignore 済み。ログイン画面で動く JS がソースと食い違っている
 * 状態を作りたくないため、コミットせず毎回生成する。
 * auth-worker の dev / build / typecheck / test はすべてこのスクリプトを
 * 先に実行するので、古いバンドルのまま検査が通ることが起こらない。
 */

const root = join(import.meta.dirname, "..");
const entry = join(root, "src/presentation/http/ui/client/login-island.tsx");
const outFile = join(root, "src/presentation/http/ui/generated/login-island.bundle.ts");

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  // Workers ではなくブラウザ向け。nodejs_compat の有無とは無関係。
  platform: "browser",
  // Baseline 相当。WebAuthn を持つブラウザならこの範囲は確実に解釈できる。
  target: ["es2022"],
  minify: true,
  // ソースマップは出さない。配信すると実装の詳細が増えるうえ、
  // 配信しないなら .map への参照が 404 を生むだけ。
  sourcemap: false,
  jsx: "automatic",
  // サーバー側の .tsx は hono/jsx（SSR）、この 1 本だけ hono/jsx/dom。
  // ファイル先頭の @jsxImportSource より明示的に揃えておく。
  jsxImportSource: "hono/jsx/dom",
  write: false,
  logLevel: "warning",
});

const [output] = result.outputFiles ?? [];
if (output === undefined) throw new Error("esbuild produced no output");

const banner =
  "// 生成物。手で編集しない。scripts/build-client.mjs が\n" +
  "// src/presentation/http/ui/client/login-island.tsx から作る。\n";

await mkdir(dirname(outFile), { recursive: true });
await writeFile(
  outFile,
  `${banner}export const LOGIN_ISLAND_JS = ${JSON.stringify(output.text)};\n`,
  "utf8",
);

const kib = (output.text.length / 1024).toFixed(1);
console.log(`built login island: ${kib} KiB`);
