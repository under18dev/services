// JSX の style 属性を書いた時点で落とす（#326、#320 の後追い）。
//
// #320 で「画面が CSP の許していないものを使っていないか」をテスト実行時に見る検査が
// 入った（HTML を返す 3 Worker すべてで `style="` と `<style` を拒否、`raw()` 経由で
// 埋め込んだ場合も捕まる）。あれが本質的な検査で、これは置き換えではない。
//
// 残っていたのは気づく時点だった——レンダリング後の HTML を見るので、テストを
// 走らせるまで分からない。ここでは書いた瞬間（エディタ上 / lint 時）に気づけるように
// する。#320 より弱い（書いた場所しか見ない。`raw()` 経由は捕まえない）ので、
// 両方あって初めて「書いた瞬間に気づく」と「どう書いても漏れない」が揃う。
//
// 本番の CSP は `style-src 'self'` で、インラインの `style` 属性はブラウザに
// 破棄される——#316 で `/account` に `style="margin-top:1.25rem"` が 2 箇所入り、
// 本番でだけパネルが密着して気づかれた。

/** @type {import("typescript-eslint").ConfigArray} */
export default [
  {
    files: ["apps/*/src/presentation/http/ui/**/*.tsx", "packages/web-ui/src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'JSXAttribute[name.name="style"]',
          message:
            "インラインの style 属性は使えない（CSP が style-src 'self' で、" +
            "ブラウザが属性ごと捨てる）。@u18/web-ui のクラス（kiwa/island-classes.ts 等）へ足すこと。",
        },
      ],
    },
  },
];
