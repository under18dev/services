// @ts-check
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `pnpm preview:html` の入口（3b の依頼——運用者が admin-worker の
 * 画面をログイン無しで確認できる静的 HTML を書き出す）。
 *
 * ## なぜ esbuild で一度バンドルしてから実行するのか
 *
 * `scripts/preview-html.generator.mts` は hono/jsx（`"jsxImportSource":
 * "hono/jsx"`）で画面を描く。plain Node（`node file.mts`）には TypeScript
 * と JSX の変換が無いので、そのままは動かせない。
 *
 * esbuild の `jsx` / `jsxImportSource` を明示して bundle する——
 * `.tsx` ファイルの近くにある `tsconfig.json` を自動で見に行く経路に
 * 頼ると、`packages/web-ui` 側のファイルで JSX の変換先がずれて
 * `ReferenceError: React is not defined` になることを実測した
 * （esbuild 自体の tsconfig 自動検出はファイルごとに一貫するとは
 * 限らない）。ここで明示すれば、どのファイルも同じ設定で変換される。
 *
 * ## 一時ファイルへ書いてから `import()` する
 *
 * `write: false` で受け取った文字列をそのまま `import()` できない
 * （data: URL はこの大きさ——600 KB 超——だと扱いにくい）。OS の
 * 一時ディレクトリへ書き出し、使い終わったら消す。
 *
 * ## 出力先は環境変数で渡す
 *
 * バンドル後の `import.meta.url` は一時ファイルの場所を指してしまうので、
 * 生成スクリプト側では使えない。絶対パスをここで組み立てて
 * `PREVIEW_OUTPUT_DIR` として渡す。
 */

const root = new URL("..", import.meta.url).pathname;
const outputDir = join(root, "preview-html");
const entryPoint = join(root, "scripts/preview-html.generator.mts");

const result = await build({
  entryPoints: [entryPoint],
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  jsx: "automatic",
  jsxImportSource: "hono/jsx",
  write: false,
  logLevel: "warning",
});

const [output] = result.outputFiles ?? [];
if (output === undefined) throw new Error("esbuild が何も出力しませんでした");

const tempDir = await mkdtemp(join(tmpdir(), "admin-preview-html-"));
const tempFile = join(tempDir, "generator.mjs");
await writeFile(tempFile, output.text, "utf8");

process.env.PREVIEW_OUTPUT_DIR = outputDir;

try {
  await import(tempFile);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
