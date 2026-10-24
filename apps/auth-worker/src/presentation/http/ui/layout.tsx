import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";

/**
 * Auth UI の共通レイアウト（仕様書 14-1 の決定 4）。
 *
 * ログイン画面だけでなく、`/oauth/authorize` の同意画面（#15）でも
 * そのまま使えるようにしてある。画面固有のものはここに置かない。
 *
 * - スクリプトは**外部ファイルだけ**。インライン `<script>` を書くと
 *   `script-src 'self'` の CSP に引っかかり、`'unsafe-inline'` か nonce が
 *   必要になる。ログイン画面で XSS の緩和を弱めたくないので外部に出す
 *   （CSP の定義は ui/login.routes.ts）。
 * - `scripts` が未指定なら `<script>` が 1 つも出ない。JS 無しで成立する
 *   画面（同意画面など）はそのまま使える。
 */
export type LayoutProps = {
  readonly title: string;
  /** 読み込む外部スクリプトのパス。インライン化はしない。 */
  readonly scripts?: readonly string[];
  readonly children?: Child;
};

export const Layout: FC<LayoutProps> = ({ title, scripts = [], children }) => (
  <>
    {raw("<!DOCTYPE html>")}
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* 認証画面は検索結果に出す意味がない。 */}
        <meta name="robots" content="noindex, nofollow" />
        <title>{title} | u18 Identity</title>
        <link rel="stylesheet" href="/ui/u18.css" />
        {scripts.map((src) => (
          <script key={src} type="module" src={src} defer />
        ))}
      </head>
      <body>
        <main class="card">
          <h1 class="brand">u18 Identity</h1>
          {children}
        </main>
      </body>
    </html>
  </>
);
