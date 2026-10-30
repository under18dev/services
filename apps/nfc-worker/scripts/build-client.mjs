// @ts-check
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

/**
 * カード画面が配信する生成物を作る（#338）。
 *
 * **dashboard-worker の `scripts/build-client.mjs` と同じ形。**
 * いまあるのはスタイルシート（Tailwind v4）だけで、**アイランドはまだ
 * 無い。**
 *
 * ## 2 つ作る
 *
 * スタイルシート（Tailwind v4）とアイランド（esbuild）。`emit()` が
 * 生成物を `.ts` として書くところは共通で、違うのは組み立て方だけ。
 *
 * **アイランドは #338 で入った。** それまでは `buildIsland()` を
 * 意図的に空けてあった —— 入口のファイルが無いのに空で置くと、
 * **「宣言はあるが繋がっていない」**（#88 / #96 / #122 / #164）を
 * こちらから作ることになるため。
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

/**
 * カード画面のアイランドをブラウザ向けにバンドルする（#338）。
 *
 * **Workers Assets を使わず文字列として Worker に埋め込む。** 理由は
 * auth-worker / dashboard-worker の同名スクリプトと同じ。
 *
 * ## 大きさを出している
 *
 * `cn`（`clsx` + `tailwind-merge`）を引き込むと**それだけで 27.8 KB**
 * になる（#341 の実測）。class 文字列はサーバー側で組み立てて渡す形に
 * してあるので（`ui/island-classes.ts`）、ここの出力が急に膨らんだら
 * **島が何かを引き込んだ合図**である。
 */
async function buildIsland() {
  const result = await build({
    entryPoints: [join(root, "src/presentation/http/ui/client/cards-island.ts")],
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

  await emit("cards-island.bundle.ts", "CARDS_ISLAND_JS", output.text);
  return output.text;
}

const [stylesheet, island] = await Promise.all([buildStylesheet(), buildIsland()]);

console.log(`built kiwa stylesheet: ${(stylesheet.length / 1024).toFixed(1)} KiB`);
console.log(`built cards island: ${(island.length / 1024).toFixed(1)} KiB`);
