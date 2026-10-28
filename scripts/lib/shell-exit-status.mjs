/**
 * `set -e` の下で、一致ゼロの `grep` を変数に取る形を見つける（#231）。
 *
 * ## 何が起きるか
 *
 *   var="$(... | grep foo)"
 *
 * `grep` は一致が無いと 1 で終わる。代入文の終了コードはコマンド置換の
 * 終了コードなので、`set -e` の下では**その場でスクリプトが落ちる。**
 * 直後に書いた「見つからなかった場合」の分岐には届かない。
 *
 * **落ちること自体は正しい。問題は何も言わずに落ちること。** 呼び出し側は
 * 「スクリプトが失敗した」としか分からず、検査が用意していた
 * `::error::` の 1 行が出ない。デプロイが赤いのに理由が無い状態になる。
 *
 * ## このリポジトリで 3 回起きている
 *
 * - `deploy.yml` の preflight（`grep -c` + `pipefail`。プレースホルダが
 *   全部埋まった＝成功したときだけ落ちるので、**直したつもりの変更が
 *   原因で落ちる**という最も分かりにくい形になった）
 * - `smoke-form-probe.sh` の `referrer_policy=`（#230）
 * - 同じファイルの `token=`（#227 の時点から。**ログイン画面が壊れた
 *   ときに一番読みたい 1 行**が出なかった）
 *
 * ## 直し方
 *
 * 末尾に `|| true` を付ける。`grep` の終了コードを「見つかったか」の
 * 判定に使っているなら、代入ではなく `if` の条件に置く。
 *
 * ## `pipefail` が要るかどうかは見ない
 *
 * `grep` がパイプの最後なら、`pipefail` が無くても代入の終了コードは
 * `grep` のものになる。途中にあるなら `pipefail` で拾われる。どちらでも
 * 落ちうるので、**設定を読み分けずに形だけで拾う。**
 */

/** 一致ゼロで非 0 を返し、「無いこと」が正常でもありうるコマンド。 */
const RISKY = /(?:^|[|;&(\s])(?:e|f)?grep\b/;

/**
 * `|| true` / `|| :` で握りつぶしてあるか。
 *
 * **置換の内側にも外側にも書ける。**
 *
 *   v="$(grep x f || true)"   <- 内側（こちらが普通）
 *   v="$(grep x f)" || true   <- 外側
 *
 * どちらも守られているので、閉じ括弧・引用符・セミコロン・行末のいずれかが
 * 続く形をまとめて見る。
 *
 * **迷ったら「守られている」に倒す。** 直した人に「まだ直っていない」と
 * 言う検査は、2 回目から読まれなくなる。見逃しは残るが、そちらは
 * 次に踏んだときにこの登録簿へ足せる。
 */
const GUARDED = /\|\|\s*(?:true|:)\s*(?:\)|"|'|;|$)/;

/**
 * 代入の始まり。`local` / `declare` / `export` 付きも拾う。
 *
 * **`if var=$(...)` は拾わない。** あの形は終了コードを `if` が食べるので
 * `set -e` は発動しない。行頭から見ているので自然に外れる。
 */
const ASSIGNMENT = /^\s*(?:local\s+|declare\s+|export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/;

/** 行末の `\` で続く行を 1 つの論理行にまとめる。 */
function logicalLines(source) {
  const out = [];
  let buffer = null;
  source.split("\n").forEach((raw, index) => {
    const continues = /\\\s*$/.test(raw);
    const text = raw.replace(/\\\s*$/, "");
    if (buffer === null) buffer = { line: index + 1, text };
    else buffer.text += ` ${text.trim()}`;
    if (!continues) {
      out.push(buffer);
      buffer = null;
    }
  });
  if (buffer !== null) out.push(buffer);
  return out;
}

/** コメント行か。 */
const isComment = (text) => /^\s*#/.test(text);

/**
 * 危ない代入を探す。
 *
 * @param {string} source シェルスクリプト本文
 * @returns {{line: number, name: string, text: string}[]}
 */
export function findUnguardedAssignments(source) {
  const found = [];
  for (const { line, text } of logicalLines(source)) {
    if (isComment(text)) continue;
    const assignment = ASSIGNMENT.exec(text);
    if (assignment === null) continue;
    // コマンド置換を含まない代入（リテラル）は関係しない。
    if (!/\$\(/.test(text)) continue;
    if (!RISKY.test(text)) continue;
    if (GUARDED.test(text)) continue;
    found.push({ line, name: assignment[1], text: text.trim() });
  }
  return found;
}

/**
 * `set -e` を有効にしているシェルスクリプトか。
 *
 * **ワークフローの `run:` には使わない。** GitHub Actions の既定のシェルは
 * `bash -e` なので、`set -e` を書いていなくても有効である。
 */
export function enablesErrExit(source) {
  return /^\s*set\s+-[a-zA-Z]*e/m.test(source);
}

/**
 * ワークフローの YAML から `run:` ブロックを取り出す。
 *
 * YAML パーサを足さずに済ませている。見るのは `run: |` と `run: >` の
 * 直後から、インデントが浅くなるまで。
 *
 * **ブロックごとにまとめて返す。行ごとに切ってはいけない。** シェルは
 * 行末の `\` で次の行へ続き、`|| true` がその続きに書かれていることが
 * ある。行ごとに判定すると**守られているものを「守られていない」と言う**
 * —— 実際、この検査の最初の実行で `ci.yml` の codeql-action の照合
 * （`|| true` は継続行にある）を誤検知した。
 *
 * @returns {{startLine: number, text: string}[]} 元の行番号（1 始まり）と本文
 */
export function extractRunBlocks(yamlSource) {
  const lines = yamlSource.split("\n");
  /** @type {{startLine: number, text: string}[]} */
  const blocks = [];
  let indent = null;
  let current = null;

  const open = (raw, index) => {
    const start = /^(\s*)(?:-\s+)?run:\s*[|>][-+]?\s*$/.exec(raw);
    if (start === null) return false;
    indent = start[1].length;
    current = { startLine: index + 2, lines: [] };
    return true;
  };

  const close = () => {
    if (current !== null && current.lines.length > 0) {
      blocks.push({ startLine: current.startLine, text: current.lines.join("\n") });
    }
    indent = null;
    current = null;
  };

  lines.forEach((raw, index) => {
    if (indent === null) {
      open(raw, index);
      return;
    }
    const deeper = /^\s*/.exec(raw)[0].length > indent;
    if (raw.trim() === "" || deeper) {
      current.lines.push(raw);
      return;
    }
    close();
    open(raw, index);
  });
  close();

  return blocks;
}
