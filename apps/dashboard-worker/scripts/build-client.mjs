// @ts-check
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build } from "esbuild";

/**
 * アカウント管理画面のアイランドをブラウザ向けにバンドルする。
 *
 * auth-worker の `scripts/build-client.mjs` と同じ形。Workers Assets を
 * 使わず**文字列として Worker に埋め込む**理由、生成物をコミットしない
 * 理由は、あちらのコメントを参照。
 *
 * ## バンドルの大きさを出している
 *
 * このアイランドは `hono/client` の `hc` を引き込む。**ログインの
 * アイランドと違い「無いと機能しない」わけではない**（取り消しができなく
 * なるだけで、一覧は読める）ので、大きさが見合っているかは出力を見て
 * 判断できるようにしておく。
 */

const root = join(import.meta.dirname, "..");
const entry = join(root, "src/presentation/http/ui/client/account-island.ts");
const outFile = join(root, "src/presentation/http/ui/generated/account-island.bundle.ts");

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  // Workers ではなくブラウザ向け。
  platform: "browser",
  target: ["es2022"],
  minify: true,
  // 配信しないので .map への参照は 404 を生むだけ。
  sourcemap: false,
  write: false,
  logLevel: "warning",
});

const [output] = result.outputFiles ?? [];
if (output === undefined) throw new Error("esbuild produced no output");

const banner =
  "// 生成物。手で編集しない。scripts/build-client.mjs が\n" +
  "// src/presentation/http/ui/client/account-island.ts から作る。\n";

await mkdir(dirname(outFile), { recursive: true });
await writeFile(
  outFile,
  `${banner}export const ACCOUNT_ISLAND_JS = ${JSON.stringify(output.text)};\n`,
  "utf8",
);

console.log(`built account island: ${(output.text.length / 1024).toFixed(1)} KiB`);
