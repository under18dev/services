/**
 * 追跡されているファイルの中に、生成物の形のものが無いかを見る（#388）。
 *
 * ## 何が起きたか
 *
 * #388（`feat/nfc-burn-script`、2026-10-30）が `scripts/__pycache__/` を
 * 一緒に持ち込んだ。`.pyc` が 3 つ、main に入ったままになっていた。
 * その時点で `.gitignore` に Python の行は 1 つも無かった。
 *
 * ## なぜ `.gitignore` を読む検査にしないか
 *
 * **`.gitignore` は「まだ追跡していないファイル」しか止めない。** 既に
 * 追跡されているものは、後から無視規則を足しても出てこない —— 今回
 * 入ったのがまさにその形である。だから「`.gitignore` に書いてあるか」を
 * 見ても、入ってしまった後の状態は見つからない。
 *
 * この検査は**実際に git に入っているファイルの一覧**（`git ls-files`）を
 * 見る。`.gitignore` は読まない。片方が直っていてもう片方が直っていない
 * 状態を見つけたいので、2 つは独立していなければ意味がない。
 *
 * ## 規則をここに並べて持つ
 *
 * `.gitignore` から読み取ると上の独立性が崩れる（`.gitignore` の行を
 * 消せば検査も黙る）ので、**見る形はこのファイルに書く。** 足すときは
 * 「作り直せるもの」だけにすること。手で書いたものが 1 つでも引っかかる
 * 検査は、2 回目から `--no-verify` で飛ばされる。
 *
 * ## 資格情報（`.dev.vars` / `.env`）は見ない
 *
 * 同じ「`.gitignore` では止まらない」形だが、見つけたときの手当てが
 * 違う（値を失効させる、履歴を扱うかを決める）。この検査は
 * **消せば済むもの**だけを扱う。
 */

/**
 * 生成物の形。`git ls-files` が返すリポジトリ相対のパスに当てる。
 *
 * `match` はパスの一部に当たればよい（ディレクトリは `/` を含めて書き、
 * `foo/distribution` のようなものに当たらないようにしてある）。
 */
export const ARTIFACT_RULES = [
  {
    label: "__pycache__/",
    match: /(?:^|\/)__pycache__\//,
    hint: "CPython が .py を動かすたびに作り直すバイトコード（#388 で入った）。",
  },
  {
    label: "*.pyc / *.pyo",
    match: /\.py[co]$/,
    hint: "CPython のバイトコード。元の .py から作り直せる。",
  },
  {
    label: "node_modules/",
    match: /(?:^|\/)node_modules\//,
    hint: "pnpm install の生成物。",
  },
  {
    label: "dist/",
    match: /(?:^|\/)dist\//,
    hint: "build の出力。",
  },
  {
    label: "coverage/",
    match: /(?:^|\/)coverage\//,
    hint: "test --coverage の出力。",
  },
  {
    label: ".turbo/ / .wrangler/",
    match: /(?:^|\/)\.(?:turbo|wrangler)\//,
    hint: "turbo と wrangler のローカルな作業場所。",
  },
  {
    label: "*.tsbuildinfo",
    match: /\.tsbuildinfo$/,
    hint: "tsc の差分ビルド用の控え。",
  },
  {
    label: "*.log",
    match: /\.log$/,
    hint: "実行時のログ。",
  },
  {
    label: ".DS_Store",
    match: /(?:^|\/)\.DS_Store$/,
    hint: "Finder が作る。中身はそのフォルダの表示設定で、リポジトリとは関係がない。",
  },
  {
    label: "presentation/http/ui/generated/",
    match: /\/presentation\/http\/ui\/generated\//,
    hint: "クライアントアイランドのバンドル（scripts/build-client.mjs の生成物）。",
  },
];

/**
 * `git ls-files -z` の出力をパスの配列にする。
 *
 * **`-z` で受ける。** 改行を含むファイル名を 2 つに割らないため。
 * 末尾は必ず NUL で終わるので、空の要素が 1 つ残る。
 *
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseLsFiles(stdout) {
  return stdout.split("\0").filter((line) => line !== "");
}

/**
 * 追跡されているパスのうち、生成物の形のものを返す。
 *
 * @param {string[]} paths リポジトリ相対のパス
 * @returns {{path: string, label: string, hint: string}[]}
 */
export function findTrackedArtifacts(paths) {
  /** @type {{path: string, label: string, hint: string}[]} */
  const found = [];
  for (const path of paths) {
    const rule = ARTIFACT_RULES.find((candidate) => candidate.match.test(path));
    if (rule === undefined) continue;
    found.push({ path, label: rule.label, hint: rule.hint });
  }
  return found;
}
