/**
 * 文書が「#N で決める」と**これからのこと**として指している issue を集める。
 *
 * ## なぜ要るのか
 *
 * 論点を issue に預けて文書から指す、という書き方をしている。**指した先が
 * 閉じると、論点は未決のまま一覧から消える。** 閉じた側は正しい ——
 * その issue の本体は終わっているので、閉じるのが筋である。残件だけが
 * どこからも見えなくなる。
 *
 * **このリポジトリで 3 回起きている。**
 *
 * - 仕様書 14.2 が `#43` / `#27` を指したまま（#257 で気づいて注記を足した）
 * - 同じ節が `#265` を指したまま（#286 へ移した）
 * - §7.0 / §7.1 / 決定 7 の「保持期間は未決」が `#27` / `#51` / `#43` を指したまま。
 *   **こちらは保持期間が決着した後も「未決」と書いてあった**
 *
 * **3 回目なので検査にする**（`check-route-patterns.mjs` と同じ基準）。
 *
 * ## 何を拾うか
 *
 * **これからのこととして指しているものだけ。** 「#265 で実装する」は拾い、
 * 「#265 で実装済み」「#273 で対象に入れた」は拾わない。済んだ話として
 * 閉じた issue を指すのは正しい書き方なので、落としてはいけない。
 *
 * **引用（`>`）の中は見ない。** あの囲みは決定が下りた時点の記録で、
 * 後から書き換える対象ではない。現在の追跡先は地の文に書く。
 *
 * **コードブロックの中も見ない。** 例示のコマンドやログに `#` が出る。
 */

/** これからのことを指す形。動詞は言い切り（「〜する」「〜る」）に限る。 */
const FORWARD = String.raw`#(\d+)\s*(?:で|を|が|に)[^。、）\n]{0,14}?(?:決める|決まる|扱う|実装する|入れる|入る|直す|待つ|追う|対応する|検討する|進める|移す|やる|書く)`;

/** 「#N が入るまで」「#N を待っている」のような、完了を前提にした言い回し。 */
const UNTIL = String.raw`#(\d+)\s*(?:が入る|の決着|の解決)まで`;

const MARKER = new RegExp(`${FORWARD}|${UNTIL}`, "gu");

/**
 * 1 つのファイルから、これからのこととして指している issue 番号を取り出す。
 *
 * @param {string} path 報告に使う名前
 * @param {string} text ファイルの中身
 * @returns {{path: string, line: number, number: number, text: string}[]}
 */
export function findForwardIssueRefs(path, text) {
  const found = [];
  let inFence = false;

  for (const [index, line] of text.split("\n").entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // 引用の中は過去の記録。現在の追跡先ではない。
    if (/^\s*>/.test(line)) continue;

    MARKER.lastIndex = 0;
    let match;
    while ((match = MARKER.exec(line)) !== null) {
      const number = Number(match[1] ?? match[2]);
      found.push({
        path,
        line: index + 1,
        number,
        text: match[0].replaceAll("*", "").trim(),
      });
    }
  }

  return found;
}
