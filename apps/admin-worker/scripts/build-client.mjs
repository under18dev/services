// @ts-check
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

/**
 * admin-worker が配信する生成物を作る（#390 決定 16 ③ / #470）。
 *
 * **nfc-worker / dashboard-worker の同名スクリプトと同じ形。** 2 つある
 * ——ブラウザ向けのアイランド（esbuild）と、画面のスタイルシート
 * （Tailwind v4）。
 *
 * **アイランドは #470 で足した。** それまでは「最初の画面は form POST +
 * JS 無しで完結する」という理由で `buildIsland()` を持たなかった
 * （このコメントの直前の版を参照）。並べ替え・絞り込み・コピー・通知の
 * トーストは、サーバーの form POST では作れない後付けの便利さなので、
 * アイランドが要るようになった。
 *
 * ## このスクリプトが `dev` / `build` / `typecheck` / `test` の前段にいる
 *
 * `package.json` の該当スクリプトすべてが先にこれを呼び、さらに
 * `wrangler.jsonc` の `build.command` にも置くこと。**CI の deploy は
 * `wrangler deploy` を直接呼んで npm スクリプトを迂回する**ので、
 * 両方に無いと「生成が走らないままデプロイ」（#132）に戻る。
 */

const root = join(import.meta.dirname, "..");
const generatedDir = join(root, "src/presentation/http/ui/generated");

const banner =
  "// 生成物。手で編集しない。scripts/build-client.mjs が作る。\n" +
  "// dev / build / typecheck / test の前段で毎回作り直すのでコミットしない。\n";

async function emit(fileName, exportName, content) {
  await mkdir(generatedDir, { recursive: true });
  await writeFile(
    join(generatedDir, fileName),
    `${banner}export const ${exportName} = ${JSON.stringify(content)};\n`,
    "utf8",
  );
}

/**
 * 並べ替え・絞り込み・コピー・タブ・通知のアイランドをブラウザ向けに
 * バンドルする（#470）。
 *
 * **`.test.ts` を巻き込まない。** `ui/client/` には `admin-island.test.ts`
 * も置いてあるが、エントリポイントに指定していないので esbuild が辿る
 * ことはない（`vitest` を import しており、束ねると壊れる）。
 */
async function buildIsland() {
  const result = await build({
    entryPoints: [join(root, "src/presentation/http/ui/client/admin-island.ts")],
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

  await emit("admin-island.bundle.ts", "ADMIN_ISLAND_JS", output.text);
  return output.text;
}

/**
 * Kiwa UI のスタイルシートを Tailwind v4 で組む。
 *
 * ハッシュはここで計算していない。`@u18/web-ui` の `asset-hash.ts` が
 * 配信する文字列そのものから実行時に計算する（#132 / #211）。
 */
async function buildStylesheet() {
  const entry = join(root, "src/presentation/http/ui/kiwa.css");
  const result = await postcss([tailwindcss({ optimize: true })]).process(
    await readFile(entry, "utf8"),
    { from: entry },
  );

  await emit("kiwa-stylesheet.ts", "KIWA_STYLESHEET", result.css);
  return result.css;
}

const [island, stylesheet] = await Promise.all([buildIsland(), buildStylesheet()]);

console.log(`built admin island: ${(island.length / 1024).toFixed(1)} KiB`);
console.log(`built kiwa stylesheet: ${(stylesheet.length / 1024).toFixed(1)} KiB`);
