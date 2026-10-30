// @ts-check
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

/**
 * admin-worker が配信する生成物を作る（#390 決定 16 ③）。
 *
 * **nfc-worker / dashboard-worker の同名スクリプトと同じ形。** いま作る
 * のはスタイルシート（Tailwind v4）だけで、**アイランドは無い** ——
 * 最初の画面（NFC 管理）は画面ごと form POST + JS 無しで完結する想定
 * なので、無い実体へ `buildIsland()` を空けておかない
 * （nfc-worker の同スクリプトが「宣言はあるが繋がっていない」経路を
 * 自分から作らないと書いているのと同じ判断）。
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

const stylesheet = await buildStylesheet();

console.log(`built kiwa stylesheet: ${(stylesheet.length / 1024).toFixed(1)} KiB`);
