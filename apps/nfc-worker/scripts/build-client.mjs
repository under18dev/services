// @ts-check
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

/**
 * カード画面が配信する生成物を作る（#338）。
 *
 * **dashboard-worker の `scripts/build-client.mjs` と同じ形。**
 * いまあるのはスタイルシート（Tailwind v4）だけで、**アイランドはまだ
 * 無い。**
 *
 * ## 無いものをビルドしない
 *
 * dashboard 側には `buildIsland()`（esbuild）が並んでいるが、
 * こちらには入れていない。`src/presentation/http/ui/client/` が
 * まだ存在せず、**入口の空ファイルを置くと「宣言はあるが繋がって
 * いない」**（#88 / #96 / #122 / #164）をこちらから作ることになる。
 *
 * **足すときは `buildStylesheet()` の隣に置く。** `emit()` が生成物を
 * `.ts` として書くところは共通なので、増えるのは esbuild を呼ぶ関数と
 * `Promise.all` の 1 要素だけになる。入口と名前は
 *
 *     src/presentation/http/ui/client/cards-island.ts
 *     -> generated/cards-island.bundle.ts  (export CARDS_ISLAND_JS)
 *
 * で合意済み（dashboard の `account-island` / `ACCOUNT_ISLAND_JS` に
 * 揃えてある）。
 *
 * ## このスクリプトが `dev` / `build` / `typecheck` / `test` の前段にいる
 *
 * `package.json` の 4 つのスクリプトすべてが先にこれを呼び、さらに
 * `wrangler.jsonc` の `build.command` にも置いてある。**CI の deploy は
 * `wrangler deploy` を直接呼んで npm スクリプトを迂回する**ので、
 * 両方に無いと「生成が走らないままデプロイ」（#132）に戻る。
 * dashboard が同じ形を一度踏んでいる。
 */

const root = join(import.meta.dirname, "..");
const generatedDir = join(root, "src/presentation/http/ui/generated");

const banner =
  "// 生成物。手で編集しない。scripts/build-client.mjs が作る。\n" +
  "// dev / build / typecheck / test の前段で毎回作り直すのでコミットしない。\n";

/**
 * 生成物を 1 つ書く。
 *
 * **`JSON.stringify` で文字列リテラルにする。** CSS にも JS にも
 * バッククォートや `${` が入りうるので、テンプレートリテラルで囲むと
 * 中身がコードとして解釈される。
 */
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
 * ## ハッシュをここで計算していない
 *
 * `@u18/web-ui` の `asset-hash.ts` は「**配信する文字列そのもの**から
 * 実行時にハッシュを計算する」設計で、理由は #132 —— 生成物とハッシュが
 * ずれると、ブラウザから見て「中身が変わったのに URL が同じ」になる。
 *
 * ここが作るのは「CSS を入れた `.ts`」だけで、ハッシュは
 * `hashedFileName("kiwa.css", KIWA_STYLESHEET)` が**配信するのと同じ
 * 文字列から**出す（`ui/asset-paths.ts`）。このスクリプトが古い CSS を
 * 書いても、URL も古いほうのハッシュになる。
 */
async function buildStylesheet() {
  const entry = join(root, "src/presentation/http/ui/kiwa.css");
  const result = await postcss([tailwindcss({ optimize: true })]).process(
    await readFile(entry, "utf8"),
    // **`from` を渡す。** `@import` と `@source` の相対パスはこのファイル
    // からの相対で解かれる。渡さないと `tailwindcss` 自体が見つからない。
    { from: entry },
  );

  await emit("kiwa-stylesheet.ts", "KIWA_STYLESHEET", result.css);
  return result.css;
}

const stylesheet = await buildStylesheet();

console.log(`built kiwa stylesheet: ${(stylesheet.length / 1024).toFixed(1)} KiB`);
