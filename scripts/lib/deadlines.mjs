/**
 * 文書に書かれた「決める期限」を集めて、過ぎたものを報せる。
 *
 * ## なぜ要るのか
 *
 * 残課題を「必要になったら」「余裕ができたら」と条件で書くと、**条件を誰も
 * 監視しない**。実際このリポジトリでは、`deploy.yml` に「#106 が直るまで
 * 落ちる」という断り書きが #106 の解決後も 4 日残り、**その下に足した検査が
 * 赤くなっても「既知」で流れる**状態になっていた（#234）。
 *
 * 日付で書けば機械が見られる。ランブック §13.2 が最初の利用者である。
 *
 * **ただし日付を書いただけでは、やはり誰も見ない。** この file が見る。
 *
 * ## I/O を持たない
 *
 * 読み込みと報告は `scripts/check-deadlines.mjs` にある。ここは文字列と
 * 日付だけを扱うので、`node --test` から実時刻に依らず確かめられる
 * （`bucket-visibility.mjs` と同じ分け方）。
 */

/**
 * 期限の書き方。
 *
 * `**決める期限: 2026-11-30。**` のように、**強調の中**に書かれたものだけを
 * 拾う。地の文の日付（「#106 は 2026-10-24 に閉じた」のような**過去の事実**）
 * を拾わないためで、ランブックには実際その種の日付がある。
 */
const MARKER = /\*\*[^*\n]*?期限: (\d{4})-(\d{2})-(\d{2})。?[^*\n]*?\*\*/gu;

/** `YYYY-MM-DD` を UTC の日付として数値にする。時刻を持たない比較にする。 */
function toDayNumber(year, month, day) {
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

/**
 * 1 つのファイルの本文から期限を取り出す。
 *
 * @param {string} path 報告に使う名前
 * @param {string} text ファイルの中身
 * @returns {{path: string, line: number, date: string, dayNumber: number, text: string}[]}
 */
export function findDeadlines(path, text) {
  const found = [];
  const lines = text.split("\n");

  for (const [index, line] of lines.entries()) {
    MARKER.lastIndex = 0;
    let match;
    while ((match = MARKER.exec(line)) !== null) {
      const [whole, year, month, day] = match;
      found.push({
        path,
        line: index + 1,
        date: `${year}-${month}-${day}`,
        dayNumber: toDayNumber(year, month, day),
        text: whole.replaceAll("*", "").trim(),
      });
    }
  }

  return found;
}

/**
 * 期限を今日と突き合わせる。
 *
 * **`today` を引数で受け取る。** 実時刻を読むと、過ぎた期限のテストが
 * 「いつ走らせても過ぎている」形でしか書けず、**まだ来ていない側の分岐を
 * 固定できない**。
 *
 * @param {ReturnType<typeof findDeadlines>} deadlines
 * @param {Date} today
 */
export function review(deadlines, today) {
  const todayNumber = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  const passed = deadlines.filter((d) => d.dayNumber <= todayNumber);
  const upcoming = deadlines
    .filter((d) => d.dayNumber > todayNumber)
    .sort((a, b) => a.dayNumber - b.dayNumber);

  return {
    /**
     * **0 件は成功にしない。**
     *
     * 期限が 1 つも見つからないのは「全部片付いた」かもしれないが、
     * 「書き方が変わって正規表現が当たらなくなった」かもしれず、
     * **出力はどちらでも同じ**になる。#217 で `check-route-patterns.mjs` に
     * 0 件ガードを入れたのと同じ判断（脅威モデル §4.5）。
     *
     * 本当に全部片付いたなら、この検査を外すかどうかをそのとき決めること。
     */
    ok: passed.length === 0 && deadlines.length > 0,
    empty: deadlines.length === 0,
    passed,
    upcoming,
  };
}
