/**
 * 配信 CSS の `.rounded-lg` 等のユーティリティが、実際にどの border-radius
 * 値を出しているかを見る（GDG デザイン移行 PR4、issue #535）。
 *
 * ## 何を確かめたいか
 *
 * PR1 で `--radius-lg: var(--gdg-radius-card)` としていた対応表が間違い
 * だった（GDG 自身のボタン・入力欄は 28px を使っていない）。PR4 で
 * `--radius-lg: var(--gdg-radius-md)` / `--radius-xl: var(--gdg-radius-card)`
 * へ直したが、角丸の対応表はこれで 2 回目の間違いなので、配信 CSS が
 * 実際にその値を出しているかを検査で固定する。
 *
 * ## セレクタがまとまることがある
 *
 * `--radius-md` と `--radius-lg` が同じ `--gdg-radius-md` を指すように
 * なった結果、lightningcss は同じ宣言を持つセレクタをまとめる——実際の
 * 配信 CSS には `.rounded-lg,.rounded-md{border-radius:var(--gdg-radius-md)}`
 * の形で出る（単独の `.rounded-lg{...}` ではない）。
 *
 * ## 正規表現を使わない（CodeQL `js/polynomial-redos`、`./clay-shadow` 参照）
 *
 * `clay-shadow.ts` で一度指摘された形と同じ轍を踏まないよう、ここも
 * `indexOf` で `{` / `}` を探す線形処理にしてある。
 */

/**
 * `.{className}` ユーティリティ（単独セレクタでも、他のクラスとまとめられた
 * セレクタでも）が持つ `border-radius` の値。見つからなければ `null`。
 */
export function deliveredBorderRadius(css: string, className: string): string | null {
  const needle = `.${className}`;
  let searchFrom = 0;

  while (searchFrom <= css.length) {
    const idx = css.indexOf(needle, searchFrom);
    if (idx === -1) return null;

    // セレクタの一部として完全一致しているか（`.rounded-lg2` のような
    // 偶然の前方一致ではないか）を、直後の文字で確認する。
    const after = css[idx + needle.length];
    if (after === "{" || after === ",") {
      const open = css.indexOf("{", idx);
      if (open === -1) return null;
      const close = css.indexOf("}", open);
      if (close === -1) return null;

      const body = css.slice(open + 1, close);
      const prefix = "border-radius:";
      const propIdx = body.indexOf(prefix);
      if (propIdx !== -1) return body.slice(propIdx + prefix.length).trim();
    }

    searchFrom = idx + needle.length;
  }

  return null;
}
