import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";

/**
 * HTML を返す全画面の共通レイアウト（仕様書 §14.1 決定 4）。
 *
 * ログイン画面・同意画面（auth-worker）と、アカウント管理画面
 * （dashboard-worker）で共有する。**同じオリジンで配信される別々の Worker**
 * なので、見た目と `<head>` の中身がずれると利用者には 1 つのサイトが
 * 突然変わったように見える。画面固有のものはここに置かない。
 *
 * - スクリプトは**外部ファイルだけ**。インライン `<script>` を書くと
 *   `script-src 'self'` の CSP に引っかかり、`'unsafe-inline'` か nonce が
 *   必要になる。ログイン画面で XSS の緩和を弱めたくないので外部に出す
 *   （CSP の定義は `page-headers.ts`）。
 * - `scripts` が未指定なら `<script>` が 1 つも出ない。JS 無しで成立する
 *   画面（同意画面など）はそのまま使える。
 */
export type LayoutProps = {
  readonly title: string;

  /**
   * 画面の骨格。
   *
   * - `"card"`（既定）: 中央に 1 枚のカード。ログイン・同意など、
   *   入力が 1 つで完結する画面。
   * - `"shell"`: 上端寄せの広い面。アカウント管理のように節が複数あり、
   *   一覧が縦に伸びる画面。中央寄せのままだと内容が増えたときに
   *   上端がビューポートの外へ出る。
   */
  readonly frame?: "card" | "shell";

  /**
   * 読み込むスタイルシートのパス。
   *
   * **Worker ごとに違う。** auth-worker は `/ui/u18.css`、dashboard-worker は
   * `/account/ui/u18.css` で、同じ `UI_STYLESHEET` を各自が配信している
   * （理由は `styles.ts` の「定義はここ 1 つ。配信は Worker ごとに行う」）。
   * 既定値を置かないのは、**書き忘れたら素の HTML が出る**ようにしておく
   * ため。既定を `/ui/u18.css` にすると、dashboard で指定を忘れても
   * 本番だけは（auth-worker のおかげで）たまたま動いてしまう。
   */
  readonly stylesheet: string;

  /** 読み込む外部スクリプトのパス。インライン化はしない。 */
  readonly scripts?: readonly string[];

  readonly children?: Child;
};

export const Layout: FC<LayoutProps> = ({
  title,
  frame = "card",
  stylesheet,
  scripts = [],
  children,
}) => (
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
      <body class={frame === "shell" ? "page-shell" : undefined}>
        <main class={frame === "shell" ? "shell" : "card"}>
          <h1 class="brand">u18 Identity</h1>
          {children}
        </main>
      </body>
    </html>
  </>
);
