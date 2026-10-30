import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";

/**
 * HTML を返す全画面の共通レイアウト（仕様書 §14.1 決定 4）。
 *
 * ログイン画面・同意画面（auth-worker）、アカウント管理画面
 * （dashboard-worker）、カード画面（nfc-worker）で共有する。**同じ
 * オリジンで配信される別々の Worker** なので、見た目と `<head>` の中身が
 * ずれると利用者には 1 つのサイトが突然変わったように見える。画面固有の
 * ものはここに置かない。
 *
 * - スクリプトは**外部ファイルだけ**。インライン `<script>` を書くと
 *   `script-src 'self'` の CSP に引っかかり、`'unsafe-inline'` か nonce が
 *   必要になる。ログイン画面で XSS の緩和を弱めたくないので外部に出す
 *   （CSP の定義は `page-headers.ts`）。
 * - `scripts` が未指定なら `<script>` が 1 つも出ない。JS 無しで成立する
 *   画面（同意画面など）はそのまま使える。
 *
 * ## `<body>` に class を付けない（#332）
 *
 * かつては骨格の種類を引数で選び、手書き CSS（`styles.ts`）のクラスを
 * `<body>` と `<main>` へ出していた。**全部の画面が Kiwa UI へ移って
 * 手書き CSS が消えたので、選ぶものが無くなった。** 骨格は外枠の
 * コンポーネント（`kiwa/card-shell.tsx` / `kiwa/shell.tsx`）が自分で組む。
 * **ここは `<head>` だけを受け持つ。**
 */
export type LayoutProps = {
  readonly title: string;

  /**
   * 読み込むスタイルシートのパス。
   *
   * **Worker ごとに違う。** auth-worker は `/ui/kiwa.<hash>.css`、
   * dashboard-worker は `/account/ui/kiwa.<hash>.css` で、**それぞれが
   * 自分で Tailwind を走らせている**（走査対象が違うので中身も違う）。
   * 既定値を置かないのは、**書き忘れたら素の HTML が出る**ようにしておく
   * ため。既定を 1 つ決めると、指定を忘れた Worker でも隣のおかげで
   * たまたま動いてしまう。
   */
  readonly stylesheet: string;

  /** 読み込む外部スクリプトのパス。インライン化はしない。 */
  readonly scripts?: readonly string[];

  readonly children?: Child;
};

export const Layout: FC<LayoutProps> = ({ title, stylesheet, scripts = [], children }) => (
  <>
    {raw("<!DOCTYPE html>")}
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* 認証画面は検索結果に出す意味がない。 */}
        <meta name="robots" content="noindex, nofollow" />
        <title>{title} | u18 Identity</title>
        <link rel="stylesheet" href={stylesheet} />
        {scripts.map((src) => (
          <script key={src} type="module" src={src} defer />
        ))}
      </head>
      {/*
        **`<main>` もブランドもここでは描かない。** 外枠と本文の関係は
        呼び出し側が組む（`kiwa/card-shell.tsx` / `kiwa/shell.tsx`）。
      */}
      <body>{children}</body>
    </html>
  </>
);
