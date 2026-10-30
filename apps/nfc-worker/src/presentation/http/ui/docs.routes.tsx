import { IMMUTABLE_ASSET_CACHE_CONTROL, pageSecurityHeaders } from "@u18/web-ui";
import type { Hono } from "hono";
import type { AppBindings } from "../types";
import { DOCS_STYLESHEET_PATH } from "./asset-paths";
import { DocsPage } from "./docs-page";
import { KIWA_STYLESHEET } from "./generated/kiwa-stylesheet";

/**
 * カードを受け取った人向けの案内（#358）。
 *
 * ## `go.under18.dev` にページを置くのは、これが初めてである
 *
 * それまであのホストが返していたのは **302 と素のテキスト（404）だけ**
 * だった（`redirect.routes.ts`）。HTML を返す経路が増えるので、
 * **CSP とスタイルシートの配信がここに要る。**
 *
 * ## 認証しない。その性質を壊さない
 *
 * `/c/:cardId` と同じく、**Cookie を読まないし発行もしない。**
 * カードを拾っただけの人も、まだ登録していない人も読める ——
 * **読めなければ案内の意味が無い。**
 *
 * `go.under18.dev` には `__Host-` のセッション Cookie が届かないので、
 * **仮にここでログインを要求しても永久にログイン画面へ戻るだけ**である。
 *
 * ## キャッシュしてよい
 *
 * 中身は全員に同じで、個人情報を 1 文字も含まない。カード画面
 * （`cards-ui.routes.tsx`）が `no-store` なのは所有者固有だからで、
 * **ここにその理由は無い。**
 *
 * ただし `immutable` にはしない —— **URL に内容ハッシュが入らない。**
 * 文面を直したら、そう遠くないうちに反映されてほしい。
 */
export function registerDocsRoutes(app: Hono<AppBindings>, path: string): void {
  /**
   * 案内のページが読むスタイルシート。
   *
   * **カード画面のものを借りない。** 中身は同じでハッシュも同じなので
   * 借りれば 200 で通るが、**それが #310 で踏んだ形である**
   * （`ui/asset-paths.ts` の `DOCS_STYLESHEET_ROUTE`）。
   */
  app.get(DOCS_STYLESHEET_PATH, (c) =>
    c.body(KIWA_STYLESHEET, 200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": IMMUTABLE_ASSET_CACHE_CONTROL,
    }),
  );

  app.get(path, pageSecurityHeaders, (c) => {
    // **5 分。** 文面を直したときに、そう待たずに反映されてほしい。
    // `immutable` にできるのは URL に内容ハッシュが入るものだけで、
    // このパスは `/docs` 固定である。
    c.header("Cache-Control", "public, max-age=300");
    return c.html(<DocsPage accountOrigin={c.env.ACCOUNT_ORIGIN} />);
  });
}
