// @ts-check
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

/**
 * アカウント管理画面が配信する生成物を作る。
 *
 * **2 つある。** ブラウザ向けのアイランド（esbuild）と、画面のスタイル
 * シート（Tailwind v4）。どちらも**文字列として Worker に埋め込む**。
 * Workers Assets を使わない理由、生成物をコミットしない理由は
 * auth-worker の `scripts/build-client.mjs` のコメントを参照。
 *
 * ## このスクリプトが `dev` / `build` / `typecheck` / `test` の前段にいる
 *
 * `package.json` の 4 つのスクリプトすべてが先にこれを呼ぶ。**生成が
 * 走らないままデプロイされる**（#132）形を作らないためで、Tailwind を
 * 足すにあたって一番効いているのがこの性質である。
 *
 * 下の「配信する文字列からハッシュを計算する」を読むこと。
 */

const root = join(import.meta.dirname, "..");
const generatedDir = join(root, "src/presentation/http/ui/generated");

const banner =
  "// 生成物。手で編集しない。scripts/build-client.mjs が作る。\n" +
  "// dev / build / typecheck / test の前段で毎回作り直すのでコミットしない。\n";

/**
 * 生成物を 1 つ書く。
 *
 * **`JSON.stringify` で文字列リテラルにする。** CSS にも JS にもバック
 * クォートや `${` が入りうるので、テンプレートリテラルで囲むと中身が
 * コードとして解釈される。
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
 * 取り消し操作のアイランドをブラウザ向けにバンドルする。
 *
 * ## バンドルの大きさを出している
 *
 * このアイランドは `hono/client` の `hc` を引き込む。**ログインの
 * アイランドと違い「無いと機能しない」わけではない**（取り消しができなく
 * なるだけで、一覧は読める）ので、大きさが見合っているかは出力を見て
 * 判断できるようにしておく。
 */
async function buildIsland() {
  const result = await build({
    entryPoints: [join(root, "src/presentation/http/ui/client/account-island.ts")],
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

  await emit("account-island.bundle.ts", "ACCOUNT_ISLAND_JS", output.text);
  return output.text;
}

/**
 * Kiwa UI のスタイルシートを Tailwind v4 で組む（#332）。
 *
 * ## ここが #211 とぶつかりかけたところ
 *
 * `@u18/web-ui` の `asset-hash.ts` は「**配信する文字列そのもの**から
 * 実行時にハッシュを計算する」設計で、理由は #132 ——
 * **生成物とハッシュがずれる余地**を残さないためである。Tailwind は
 * ふつうファイルを吐くので、素直に繋ぐとこの性質が壊れる。
 *
 * **壊していない。** ここが作るのは「CSS を入れた `.ts`」であって、
 * ハッシュ付きのファイル名ではない。ハッシュは実行時に
 * `hashedFileName("kiwa.css", KIWA_STYLESHEET)` が、**配信するのと同じ
 * 文字列から**計算する（`asset-paths.ts`）。
 *
 * つまりこのスクリプトが**古い CSS を書いても、URL も古いほうの
 * ハッシュになる。** ずれようがない。守っているのは
 * 「ビルドにハッシュを計算させない」の 1 点だけで、
 * **CSS を生成すること自体は #211 と無関係である。**
 *
 * ## `optimize: true` にしている
 *
 * Lightning CSS の最小化が走る。配信するのは**この最小化後の文字列**で、
 * ハッシュもそこから出る。`optimize` を切り替えると URL も変わる ——
 * それが正しい（中身が変わっているので）。
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

const [island, stylesheet] = await Promise.all([buildIsland(), buildStylesheet()]);

console.log(`built account island: ${(island.length / 1024).toFixed(1)} KiB`);
console.log(`built kiwa stylesheet: ${(stylesheet.length / 1024).toFixed(1)} KiB`);
